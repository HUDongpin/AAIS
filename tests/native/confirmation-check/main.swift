// Separate native test executable: decisions are fixtures, not real user input.
import Foundation
import Security

var checks = 0
func check(_ value: Bool) { precondition(value); checks += 1 }
func rejects(_ body: () throws -> Void) {
    do { try body(); preconditionFailure("Expected refusal") }
    catch { checks += 1 }
}
func request(_ marker: UInt8 = 1) -> OfflineRequest {
    OfflineRequest(sessionNonce: Data(repeating: marker, count: 32), releaseSHA: String(repeating: "a", count: 40),
        imageDigest: "sha256:" + String(repeating: "b", count: 64))
}
let original = request()
let success = try OneShotConfirmation(request: original, now: 100)
check(!success.keyWasCreated)
try success.confirm(original, decision: .approved, now: 101, originOK: true)
check(!success.keyWasCreated)
check(try success.signAndVerifyOnce(original, now: 102, originOK: true))
check(success.state == .consumed && success.keyWasCreated)
rejects { _ = try success.signAndVerifyOnce(original, now: 103, originOK: true) }

for decision in [ConfirmationDecision.cancelled, .unavailable, .timedOut, .failed] {
    let session = try OneShotConfirmation(request: original, now: 100)
    rejects { try session.confirm(original, decision: decision, now: 101, originOK: true) }
    check(session.state == .rejected && !session.keyWasCreated)
    rejects { try session.confirm(original, decision: .approved, now: 102, originOK: true) }
    rejects { _ = try session.signAndVerifyOnce(original, now: 103, originOK: true) }
}
for now in [99.0, 160, 161, .infinity, .nan] {
    let session = try OneShotConfirmation(request: original, now: 100)
    rejects { try session.confirm(original, decision: .approved, now: now, originOK: true) }
    check(!session.keyWasCreated)
}
for offered in [request(2), OfflineRequest(sessionNonce: original.sessionNonce, releaseSHA: String(repeating: "c", count: 40),
        imageDigest: original.imageDigest), OfflineRequest(sessionNonce: original.sessionNonce,
        releaseSHA: original.releaseSHA, imageDigest: "sha256:" + String(repeating: "d", count: 64))] {
    let before = try OneShotConfirmation(request: original, now: 100)
    rejects { try before.confirm(offered, decision: .approved, now: 101, originOK: true) }
    check(!before.keyWasCreated)
    let after = try OneShotConfirmation(request: original, now: 100)
    try after.confirm(original, decision: .approved, now: 101, originOK: true)
    rejects { _ = try after.signAndVerifyOnce(offered, now: 102, originOK: true) }
    check(!after.keyWasCreated)
}
let noConfirmation = try OneShotConfirmation(request: original, now: 100)
rejects { _ = try noConfirmation.signAndVerifyOnce(original, now: 101, originOK: true) }
check(!noConfirmation.keyWasCreated)
let badOrigin = try OneShotConfirmation(request: original, now: 100)
rejects { try badOrigin.confirm(original, decision: .approved, now: 101, originOK: false) }
check(!badOrigin.keyWasCreated)
for (now, originOK) in [(102.0, false), (160.0, true), (100.5, true)] {
    let session = try OneShotConfirmation(request: original, now: 100)
    try session.confirm(original, decision: .approved, now: 101, originOK: true)
    rejects { _ = try session.signAndVerifyOnce(original, now: now, originOK: originOK) }
    check(!session.keyWasCreated)
}
let duplicate = try OneShotConfirmation(request: original, now: 100)
try duplicate.confirm(original, decision: .approved, now: 101, originOK: true)
rejects { try duplicate.confirm(original, decision: .approved, now: 102, originOK: true) }
check(!duplicate.keyWasCreated)
for lifetime in [0.0, -1, 61, .infinity, .nan] {
    rejects { _ = try OneShotConfirmation(request: original, now: 100, lifetime: lifetime) }
}
rejects { _ = try OneShotConfirmation(request: OfflineRequest(sessionNonce: Data(), releaseSHA: "main", imageDigest: "latest"), now: 100) }
print("AAIS_NATIVE_CONFIRMATION_ASSERTIONS=\(checks)")
print("Ephemeral test signature only; no LAContext, keychain persistence, remote enrollment or live authorization.")
