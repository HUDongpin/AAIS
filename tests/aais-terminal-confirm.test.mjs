import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const run=(file,args,options={})=>spawnSync(file,args,{encoding:"utf8",timeout:20000,...options});
const read=(path)=>readFileSync(path,"utf8");
it("validates bounded one-shot confirmation without a terminal or credentials",()=>{
  const directory=mkdtempSync(join(tmpdir(),"aais-terminal-core-"));
  try {
    const binary=join(directory,"core-test");
    const compile=run("cc",["-std=c11","-Wall","-Wextra","-Werror","-I","native/terminal-confirm",
      "native/terminal-confirm/core.c","tests/native/terminal-confirm-test.c","-o",binary]);
    expect(compile.status,compile.stderr).toBe(0);
    const result=run(binary,[]); expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toContain("AAIS_TERMINAL_CONFIRM_ASSERTIONS=68");
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
it("has no biometric, signature, server action, override or terminal-mode mutation",()=>{
  const source=read("native/terminal-confirm/main.c");
  expect(source).toContain('identifier \\"org.aais.terminal-confirm\\"');
  expect(source).toContain("sandbox_init(kSBXProfileNoNetwork,SANDBOX_NAMED");
  expect(source).toContain("aais_evaluate(&first,&initial)");
  expect(source).toContain("aais_evaluate(&initial,&after)");
  expect(source).toContain("argc!=1");
  expect(source).toContain("confirm_finish(&session,&operation");
  expect(source.replace(/\/\/[^\n]*/g,"")).not.toMatch(/LAContext|SecKey|SecItem|\b(?:getenv|connect|socket|system|execve|tcsetattr|tcflush)\s*\(/);
  expect(source).toContain('authorizesLiveExecution\\\":false');
  expect(read("deploy/aliyun/aais-preload-ghcr-image.sh")).not.toContain("aais-terminal-confirm");
});
describe.skipIf(process.platform!=="darwin")("actual non-secret macOS binary",()=>{
  let binary;
  beforeAll(()=>{
    const build=run("bash",["scripts/build-aais-terminal-confirm.sh"]);
    expect(build.status,build.stderr).toBe(0);
    binary=/^BINARY=(.+)$/m.exec(build.stdout)?.[1];
    expect(binary).toContain("/output/native-terminal-confirm/build.");
  });
  afterAll(()=>{if(binary)rmSync(dirname(binary),{recursive:true,force:true});});
  it("refuses actual automation ancestry before offering confirmation",()=>{
    const result=run(binary,[],{input:"CONFIRM AAIS fake-not-a-credential\n"});
    expect(result.status,result.stderr).toBe(2);
    const report=JSON.parse(result.stdout);
    expect(report).toMatchObject({status:"origin-rejected",operationConfirmed:false,
      authorizesLiveExecution:false,credentialsRead:false,hardwareIdentityVerified:false,signingKeyProtectionVerified:false});
    expect(result.stdout).not.toContain("fake-not-a-credential");
    expect(result.stdout).not.toContain("CONFIRM AAIS");
  });
  it("does not take arguments as approval or live targets",()=>{
    for(const argument of ["--approved","--target","--fixture","--execute"]){
      const result=run(binary,[argument]); expect(result.status).toBe(64);
      expect(JSON.parse(result.stdout).status).toBe("arguments-not-allowed");
    }
  });
  it("imports no direct network, key, biometric or subprocess API",()=>{
    const symbols=run("nm",["-u",binary]); expect(symbols.status).toBe(0);
    expect(symbols.stdout).not.toMatch(/\b_(?:socket|connect|send|recv|getenv|system|execve|posix_spawn|SecKeyCreateRandomKey|SecKeyCreateSignature|SecItemCopyMatching)\s*$/m);
    expect(symbols.stdout).not.toContain("LAContext");
  });
});
