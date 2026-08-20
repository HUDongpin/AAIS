import {
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

export type AaisPasswordRecord = {
  algorithm: "scrypt";
  salt: string;
  hash: string;
};

type KdfJob = {
  password: string;
  salt: string;
  resolve: (value: Buffer) => void;
  reject: (reason: unknown) => void;
};

const passwordKdfConcurrency = 4;
const passwordKdfMaxQueuedJobs = 32;
const passwordKdfQueue: KdfJob[] = [];
const dummyPasswordRecord: AaisPasswordRecord = {
  algorithm: "scrypt",
  salt: "aais-auth-dummy-v1",
  hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

let activePasswordKdfJobs = 0;

export class AaisPasswordKdfCapacityError extends Error {
  constructor() {
    super("AAIS password verification capacity is unavailable.");
    this.name = "AaisPasswordKdfCapacityError";
  }
}

export async function verifyAaisPasswordCandidate(
  password: string,
  record: AaisPasswordRecord | null,
) {
  const candidate = record ?? dummyPasswordRecord;
  const actual = await derivePasswordHash(password, candidate.salt);
  const expected = Buffer.from(candidate.hash, "base64url");
  const hashMatches = actual.length === expected.length
    ? timingSafeEqual(actual, expected)
    : false;
  return record !== null && hashMatches;
}

export async function createAaisPasswordRecordAsync(
  password: string,
  salt = randomBytes(16).toString("base64url"),
): Promise<AaisPasswordRecord> {
  return {
    algorithm: "scrypt",
    salt,
    hash: (await derivePasswordHash(password, salt)).toString("base64url"),
  };
}

function derivePasswordHash(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const job = { password, salt, resolve, reject };
    if (activePasswordKdfJobs < passwordKdfConcurrency) {
      startPasswordKdfJob(job);
      return;
    }
    if (passwordKdfQueue.length >= passwordKdfMaxQueuedJobs) {
      reject(new AaisPasswordKdfCapacityError());
      return;
    }
    passwordKdfQueue.push(job);
  });
}

function startPasswordKdfJob(job: KdfJob) {
  activePasswordKdfJobs += 1;
  scrypt(job.password, job.salt, 32, (error, derivedKey) => {
    activePasswordKdfJobs -= 1;
    if (error) {
      job.reject(error);
    } else {
      job.resolve(derivedKey as Buffer);
    }
    const next = passwordKdfQueue.shift();
    if (next) {
      startPasswordKdfJob(next);
    }
  });
}
