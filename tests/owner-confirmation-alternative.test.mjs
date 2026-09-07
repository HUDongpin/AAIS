import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");
describe("non-biometric Owner confirmation design remains inactive", () => {
  it("separates the inactive biometric experiment from the offline terminal prototype", () => {
    const plan = JSON.parse(read("deploy/aliyun/owner-confirmation-alternative.json"));
    expect(plan.executionEnabled).toBe(false);
    expect(plan.credentialEntryEnabled).toBe(false);
    expect(plan.biometricPrototype).toEqual({ status: "inactive-experiment", ownerHardwareAvailable: false,
      retainSourceAndTests: true, automaticFallbackEnabled: false });
    expect(plan.proposedConfirmation).toEqual({ method: "explicit-terminal-operation-confirmation",
      implementationStatus: "offline-prototype-awaiting-owner-validation", requiresFreshNativeOriginCheck: true,
      requiresImmutableDisplayedOperation: true, acceptsEnvironmentApproval: false,
      acceptsPriorJsonReceipt: false, producesServerAuthorization: false,
      provesHardwareIdentity: false, provesSigningKeyProtection: false });
    expect(plan.review.productionApproval).toBe(false);
    expect(plan.review.independentSecurityReview).toBe("not-performed");
  });
  it("retains the existing origin, biometric and credential gates byte-for-byte", () => {
    // Deliberate custody guard for this design-only change. Future runtime changes
    // require explicit review of these pins, not a silent policy downgrade.
    const pins = {
      "native/launch-check/check.c": "cfd64a9b3ab04978fc5b90868ffdcc30b0136985ddf199cd60c1aab6c85cf19a",
      "native/launch-check/check.h": "41fe7ce40691d85de05f7ccab9d0bf7f2108050b39720f55a1cf9e0d53267be0",
      "native/launch-check/main.c": "5983d8e111a9e7359adb6d3959407a71a9205f9362ec9d7456a19451cc7a1457",
      "native/confirmation-check/main.swift": "6a55507327d8901628cf1958dad68eac7d74082b7c8e9ff73ffc77670e17f386",
      "native/confirmation-check/ConfirmationCore.swift": "d0f4b647e829e024e1ca859c53bcd765a869e37dcf4bca72e605087642742203",
      "native/confirmation-check/origin.c": "93401e7450677b70e5c14a50c442b6d1b6e47a8072e349e511d0f0234a16589b",
      "deploy/aliyun/aais-preload-ghcr-image.sh": "215fc780b2acefcb4fe1da24c60522b5bf26ce23e300f19c9a054af15b7cd866",
      "deploy/aliyun/owner-launcher-plan.json": "dca75c703e219c2fa9e7ebe1a6c354755ba8d71de4a83d5b50f78cdac71fa271",
    };
    for (const [path, expected] of Object.entries(pins)) {
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), path).toBe(expected);
    }
  });
  it("keeps the actual credential refusal before configuration or prompts", () => {
    const source = read("deploy/aliyun/aais-preload-ghcr-image.sh");
    const main = source.slice(source.indexOf("aais_preload_main() {"));
    const guard = main.indexOf("aais_require_audited_owner_launcher || return 1");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(main.indexOf('source "$deploy_config_file"'));
    expect(guard).toBeLessThan(main.indexOf("read -r -s ghcr_token"));
    expect(source).not.toContain("owner-confirmation-alternative.json");
    expect(source).not.toContain("operationConfirmed");
    const existing = JSON.parse(read("deploy/aliyun/owner-launcher-plan.json"));
    expect(existing.executionEnabled).toBe(false);
    expect(Object.values(existing.requiredBindings).every((value) => value === null)).toBe(true);
  });
});
