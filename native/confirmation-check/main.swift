import Foundation
import LocalAuthentication
import Security

// Owner-only demonstration, not a credential-bearing launcher. No test switches.
func report(_ status: String, confirmed: Bool = false, signed: Bool = false) {
    let value: [String: Any] = ["schemaVersion": 1, "mode": "offline-confirmation-prototype",
        "status": status, "localBiometricConfirmation": confirmed,
        "ephemeralSignatureSelfCheck": signed, "authorizesLiveExecution": false,
        "productionKeyAccessVerified": false, "secureEnclaveVerified": false,
        "credentialsRead": false, "keyPersisted": false, "networkOperationPerformed": false]
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) { print(text) }
}

guard CommandLine.arguments.count == 1 else { report("arguments-not-allowed"); exit(64) }
guard aais_confirmation_origin_begin() else { report("origin-or-sandbox-rejected"); exit(2) }
let context = LAContext()
context.localizedCancelTitle = "取消 AAIS 离线测试"
context.localizedFallbackTitle = ""
context.touchIDAuthenticationAllowableReuseDuration = 0
var policyError: NSError?
// No password policy fallback: lack of enrolled/available biometrics is a stop.
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
    context.invalidate(); report("biometrics-unavailable"); exit(3)
}
var nonce = Data(count: 32)
let randomStatus = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
guard randomStatus == errSecSuccess else { context.invalidate(); report("random-unavailable"); exit(3) }
let request = OfflineRequest(sessionNonce: nonce, releaseSHA: String(repeating: "a", count: 40),
    imageDigest: "sha256:" + String(repeating: "b", count: 64))
let session: OneShotConfirmation
do { session = try OneShotConfirmation(request: request, now: ProcessInfo.processInfo.systemUptime) }
catch { context.invalidate(); report("invalid-test-request"); exit(3) }

// Exactly one LAContext and evaluation. No automatic re-prompt/retry.
let semaphore = DispatchSemaphore(value: 0)
let lock = NSLock()
var decision: ConfirmationDecision = .failed
var waiting = true
print("AAIS 离线确认测试：仅对固定测试请求做一次临时签名和验签；不访问服务器、不部署、不读取 Key。")
print("测试目标：offline-fixture-only；操作：offline-signature-self-check。可在系统提示中取消。")
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
    localizedReason: "确认 AAIS 离线签名自检：只处理固定测试请求，不访问服务器或使用真实密钥。") { success, error in
    lock.lock()
    if waiting {
        if success { decision = .approved }
        else if let code = (error as? LAError)?.code, [.userCancel, .appCancel, .systemCancel].contains(code) { decision = .cancelled }
        else { decision = .failed }
    }
    lock.unlock()
    semaphore.signal()
}
let timedOut = semaphore.wait(timeout: .now() + 60) == .timedOut
lock.lock()
waiting = false
let completedDecision = timedOut ? ConfirmationDecision.timedOut : decision
lock.unlock()
context.invalidate()
do {
    try session.confirm(request, decision: completedDecision, now: ProcessInfo.processInfo.systemUptime,
        originOK: aais_confirmation_origin_unchanged())
    let verified = try session.signAndVerifyOnce(request, now: ProcessInfo.processInfo.systemUptime,
        originOK: aais_confirmation_origin_unchanged())
    report("offline-confirmation-self-check-passed", confirmed: true, signed: verified)
} catch let reason as ConfirmationFailure {
    report(reason.rawValue); exit(2)
} catch { report("prototype-failed"); exit(3) }
