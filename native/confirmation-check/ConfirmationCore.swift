import Foundation
import Security

// A separate offline protocol: its signatures must NEVER be accepted by ECS.
struct OfflineRequest: Equatable {
    let sessionNonce: Data
    let releaseSHA: String
    let imageDigest: String

    func message() throws -> Data {
        guard sessionNonce.count == 32,
              releaseSHA.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              imageDigest.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw ConfirmationFailure.invalidRequest
        }
        // Fixed field order, ASCII and fixed-size values; no caller-supplied command.
        return Data(("AAIS-OFFLINE-CONFIRMATION-TEST-v1\nproject=AAIS\noperation=offline-signature-self-check\n"
            + "target=offline-fixture-only\nrelease=" + releaseSHA + "\nimage=" + imageDigest
            + "\nnonce=" + sessionNonce.map { String(format: "%02x", $0) }.joined() + "\n").utf8)
    }
}

enum ConfirmationFailure: String, Error {
    case invalidRequest, invalidState, expired, changedRequest, originRejected
    case cancelled, unavailable, timedOut, authenticationFailed, cryptoFailed
}
enum ConfirmationDecision { case approved, cancelled, unavailable, timedOut, failed }

// Serial, in-process capability prototype. No key getter/export, persistence,
// keychain item, network or signature-return API. NOT a hardware access boundary.
final class OneShotConfirmation {
    enum State: String { case waiting, approved, consumed, rejected }
    private(set) var state: State = .waiting
    private(set) var keyWasCreated = false
    private let request: OfflineRequest
    private let started: TimeInterval
    private let deadline: TimeInterval
    private var lastObserved: TimeInterval
    private var key: SecKey?

    init(request: OfflineRequest, now: TimeInterval, lifetime: TimeInterval = 60) throws {
        _ = try request.message()
        guard now.isFinite, now >= 0, lifetime.isFinite, lifetime > 0, lifetime <= 60,
              (now + lifetime).isFinite else { throw ConfirmationFailure.invalidRequest }
        self.request = request; started = now; deadline = now + lifetime; lastObserved = now
    }

    private func reject(_ reason: ConfirmationFailure) throws -> Never {
        key = nil; state = .rejected
        throw reason
    }

    private func validate(_ offered: OfflineRequest, now: TimeInterval, originOK: Bool) throws {
        guard originOK else { try reject(.originRejected) }
        guard offered == request else { try reject(.changedRequest) }
        guard now.isFinite, now >= started, now >= lastObserved, now < deadline else { try reject(.expired) }
        lastObserved = now
    }

    func confirm(_ offered: OfflineRequest, decision: ConfirmationDecision, now: TimeInterval, originOK: Bool) throws {
        guard state == .waiting else { try reject(.invalidState) }
        try validate(offered, now: now, originOK: originOK)
        switch decision {
        case .cancelled: try reject(.cancelled)
        case .unavailable: try reject(.unavailable)
        case .timedOut: try reject(.timedOut)
        case .failed: try reject(.authenticationFailed)
        case .approved: state = .approved
        }
    }

    func signAndVerifyOnce(_ offered: OfflineRequest, now: TimeInterval, originOK: Bool) throws -> Bool {
        guard state == .approved else { try reject(.invalidState) }
        try validate(offered, now: now, originOK: originOK)
        // Consume before any crypto operation: errors never grant a retry.
        state = .consumed
        defer { key = nil }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
        ]
        var error: Unmanaged<CFError>?
        defer { if let error { _ = error.takeRetainedValue() } }
        key = SecKeyCreateRandomKey(attributes as CFDictionary, &error)
        guard let privateKey = key else { try reject(.cryptoFailed) }
        keyWasCreated = true
        guard let publicKey = SecKeyCopyPublicKey(privateKey),
              SecKeyIsAlgorithmSupported(privateKey, .sign, .ecdsaSignatureMessageX962SHA256),
              let signature = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256,
                  try request.message() as CFData, &error) else { try reject(.cryptoFailed) }
        guard SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256,
                try request.message() as CFData, signature, &error) else { try reject(.cryptoFailed) }
        // Verify a changed message does NOT validate under the same signature.
        var changed = try request.message(); changed.append(0)
        guard !SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256,
                changed as CFData, signature, &error) else { try reject(.cryptoFailed) }
        return true
    }
}
