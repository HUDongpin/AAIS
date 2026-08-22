import { describe, expect, it } from "vitest";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";

describe("bounded AAIS JSON request reader", () => {
  it("parses a body inside the byte limit", async () => {
    const body = JSON.stringify({ learnerInput: "你好" });
    await expect(readAaisBoundedJson(new Request("http://localhost/api/test", {
      method: "POST",
      body,
    }), { maxBytes: new TextEncoder().encode(body).byteLength })).resolves.toEqual({
      learnerInput: "你好",
    });
  });

  it("rejects a declared oversized body before consuming its stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-length": "1000" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readAaisBoundedJson(request, { maxBytes: 100 })).rejects.toMatchObject({
      reason: "too_large",
      status: 413,
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("cancels a chunked body as soon as the accumulated limit is exceeded", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readAaisBoundedJson(request, { maxBytes: 10 })).rejects.toBeInstanceOf(
      AaisRequestBodyError,
    );
    expect(cancelled).toBe(true);
  });

  it("returns a structured invalid error for empty, malformed, or invalid UTF-8 bodies", async () => {
    const inputs = [
      new Request("http://localhost/api/test", { method: "POST" }),
      new Request("http://localhost/api/test", { method: "POST", body: "not-json" }),
      new Request("http://localhost/api/test", {
        method: "POST",
        body: new Uint8Array([0xff, 0xfe]),
      }),
    ];

    for (const request of inputs) {
      await expect(readAaisBoundedJson(request, { maxBytes: 100 })).rejects.toMatchObject({
        reason: "invalid",
        status: 400,
      });
    }
  });

  it("allows a zero-byte request stream only when the caller opts into an empty body", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "DELETE",
      body: new Uint8Array(),
    });

    await expect(readAaisBoundedJson(request, {
      maxBytes: 100,
      allowEmpty: true,
    })).resolves.toBeUndefined();
  });

  it("maps a request-stream read failure to an invalid request", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("transport reset"));
      },
    });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readAaisBoundedJson(request, { maxBytes: 100 })).rejects.toMatchObject({
      reason: "invalid",
      status: 400,
    });
  });
});
