import CryptoKit
import Foundation
import Security
import Darwin

private let keyTag = "com.jeremywinchester.mnemosyne.snapshot.signing.v1"
private let trustService = "com.jeremywinchester.mnemosyne.snapshot.trust.v1"
private let trustAccount = "device"
private let appIdentifier = "com.jeremywinchester.mnemosyne"
private let helperIdentifier = "com.jeremywinchester.mnemosyne.trust-helper"

private struct Request: Codable {
    let operation: String
    let payload_base64: String?
    let expected_sequence: Int?
    let expected_attestation_id: String?
    let accepted_sequence: Int?
    let accepted_attestation_id: String?
}

private struct TrustState: Codable {
    let version: Int
    let key_id: String
    let accepted_sequence: Int
    let accepted_attestation_id: String
}

private struct Response: Codable {
    let status: String
    let key_id: String?
    let public_key_pem: String?
    let signature_base64: String?
    let trust_state: TrustState?
    let error: String?

    static func ok(keyID: String? = nil, publicKey: String? = nil, signature: String? = nil, trust: TrustState? = nil) -> Response {
        Response(status: "ok", key_id: keyID, public_key_pem: publicKey, signature_base64: signature, trust_state: trust, error: nil)
    }

    static func failure(_ message: String) -> Response {
        Response(status: "error", key_id: nil, public_key_pem: nil, signature_base64: nil, trust_state: nil, error: message)
    }
}

private func fail(_ message: String) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(Response.failure(message)), let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    }
    exit(1)
}

private func base64(_ data: Data) -> String { data.base64EncodedString() }

private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func keyTagData() -> Data { Data(keyTag.utf8) }

private func findPrivateKey() -> SecKey {
    let query: [CFString: Any] = [
        kSecClass: kSecClassKey,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: keyTagData(),
        kSecReturnRef: true
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let item else { fail("secure enclave signing key is not enrolled") }
    let key = item as! SecKey
    let attributes = SecKeyCopyAttributes(key) as? [CFString: Any]
    guard attributes?[kSecAttrTokenID] as? String == (kSecAttrTokenIDSecureEnclave as String) else {
        fail("signing key is not backed by Secure Enclave")
    }
    return key
}

private func signingIdentity(_ code: SecCode) -> (identifier: String?, team: String?) {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
        fail("static code identity lookup failed")
    }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let values = information as? [CFString: Any] else {
        fail("code-signing identity lookup failed")
    }
    return (values[kSecCodeInfoIdentifier] as? String, values[kSecCodeInfoTeamIdentifier] as? String)
}

private func designatedRequirement(_ code: SecCode) -> String {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
        fail("static code requirement lookup failed")
    }
    var requirement: SecRequirement?
    guard SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess, let requirement else {
        fail("designated code requirement is missing")
    }
    var text: CFString?
    guard SecRequirementCopyString(requirement, [], &text) == errSecSuccess, let text else {
        fail("designated code requirement is unreadable")
    }
    return text as String
}

private func codeURL(_ code: SecCode) -> URL {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
        fail("static code path lookup failed")
    }
    var path: CFURL?
    guard SecCodeCopyPath(staticCode, [], &path) == errSecSuccess, let path else {
        fail("code path lookup failed")
    }
    return (path as URL).resolvingSymlinksInPath().standardizedFileURL
}

private func normalizedTeam(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value != "not set" else { return nil }
    return value
}

private func isAdHocDesignatedRequirement(_ value: String) -> Bool {
    value.range(of: "^cdhash H\"[a-fA-F0-9]{40}\"$", options: .regularExpression) != nil
}

private func requireCoBundledLayout(parent: SecCode, helper: SecCode) {
    let parentURL = codeURL(parent)
    let helperURL = codeURL(helper)
    let helperResources = helperURL.deletingLastPathComponent()
    let helperContents = helperResources.deletingLastPathComponent()
    let helperBundle = helperContents.deletingLastPathComponent()
    let parentBundle: URL
    if parentURL.pathExtension == "app" {
        parentBundle = parentURL
    } else {
        let parentMacOS = parentURL.deletingLastPathComponent()
        let parentContents = parentMacOS.deletingLastPathComponent()
        guard parentMacOS.lastPathComponent == "MacOS", parentContents.lastPathComponent == "Contents" else {
            fail("app caller is not inside a packaged bundle")
        }
        parentBundle = parentContents.deletingLastPathComponent()
    }
    guard helperURL.lastPathComponent == "mnemosyne-trust-helper",
          helperResources.lastPathComponent == "Resources",
          helperContents.lastPathComponent == "Contents",
          helperBundle.pathExtension == "app",
          helperBundle == parentBundle else {
        fail("app and helper are not in the same packaged bundle")
    }
}

private func requireAuthorizedAppCaller() {
    var parent: SecCode?
    let attributes: [CFString: Any] = [kSecGuestAttributePid: getppid()]
    guard SecCodeCopyGuestWithAttributes(nil, attributes as CFDictionary, [], &parent) == errSecSuccess, let parent else {
        fail("authorized app caller lookup failed")
    }
    var selfCode: SecCode?
    guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else {
        fail("helper code identity lookup failed")
    }
    guard SecCodeCheckValidity(parent, [], nil) == errSecSuccess else {
        fail("app caller code signature is invalid")
    }
    guard SecCodeCheckValidity(selfCode, [], nil) == errSecSuccess else {
        fail("helper code signature is invalid")
    }
    let parentIdentity = signingIdentity(parent)
    let helperIdentity = signingIdentity(selfCode)
    guard parentIdentity.identifier == appIdentifier, helperIdentity.identifier == helperIdentifier else {
        fail("app caller identity mismatch")
    }
    let parentTeam = normalizedTeam(parentIdentity.team)
    let helperTeam = normalizedTeam(helperIdentity.team)
    // Local-only integrity mode intentionally excludes malicious same-UID re-signing from its threat model.
    let localAdHoc = parentTeam == nil && helperTeam == nil
    let sameTeam = parentTeam != nil && parentTeam == helperTeam
    guard localAdHoc || sameTeam else { fail("app caller signer identity mismatch") }
    requireCoBundledLayout(parent: parent, helper: selfCode)
    let parentRequirement = designatedRequirement(parent)
    let helperRequirement = designatedRequirement(selfCode)
    let validRequirements = localAdHoc
        ? isAdHocDesignatedRequirement(parentRequirement) && isAdHocDesignatedRequirement(helperRequirement)
        : parentRequirement.contains("identifier \"\(appIdentifier)\"") && helperRequirement.contains("identifier \"\(helperIdentifier)\"")
    guard validRequirements else {
        fail("helper designated requirement mismatch")
    }
}

private func p256SPKI(_ publicKey: SecKey) -> Data {
    var error: Unmanaged<CFError>?
    guard let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?, raw.count == 65, raw.first == 0x04 else {
        fail("secure enclave public key export failed")
    }
    let prefix = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
    return prefix + raw
}

private func publicKeyInfo() -> (String, String) {
    let privateKey = findPrivateKey()
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        fail("secure enclave public key lookup failed")
    }
    let pemData = p256SPKI(publicKey)
    let keyID = sha256Hex(pemData)
    let pem = "-----BEGIN PUBLIC KEY-----\n\(pemData.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed]))-----END PUBLIC KEY-----\n"
    return (keyID, pem)
}

private func enroll() -> (String, String) {
    var existing: CFTypeRef?
    let existingStatus = SecItemCopyMatching([
        kSecClass: kSecClassKey,
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: keyTagData(),
        kSecReturnRef: true
    ] as CFDictionary, &existing)
    if existingStatus == errSecSuccess {
        return publicKeyInfo()
    }
    guard existingStatus == errSecItemNotFound else { fail("secure enclave key lookup failed") }

    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &accessError) else {
        fail("secure enclave access-control creation failed")
    }
    let privateAttributes: [CFString: Any] = [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: keyTagData(),
        kSecAttrAccessControl: access
    ]
    let attributes: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits: 256,
        kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs: privateAttributes
    ]
    var error: Unmanaged<CFError>?
    guard SecKeyCreateRandomKey(attributes as CFDictionary, &error) != nil else {
        fail("secure enclave key enrollment failed")
    }
    return publicKeyInfo()
}

private func trustDirectory() -> String {
    let path = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Mnemosyne")
    try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

private func withTrustLock<T>(_ body: () throws -> T) rethrows -> T {
    let path = (trustDirectory() as NSString).appendingPathComponent("trust-state.lock")
    let fd = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { fail("trust lock unavailable") }
    guard flock(fd, LOCK_EX) == 0 else { close(fd); fail("trust lock unavailable") }
    defer { flock(fd, LOCK_UN); close(fd) }
    return try body()
}

private func trustQuery() -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: trustService, kSecAttrAccount: trustAccount]
}

private func readTrust() -> TrustState? {
    var query = trustQuery()
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else { fail("trust state read failed") }
    guard let state = try? JSONDecoder().decode(TrustState.self, from: data) else { fail("trust state is malformed") }
    return state
}

private func writeTrust(_ state: TrustState, replacing existing: Bool) {
    let data: Data
    do {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        data = try encoder.encode(state)
    } catch { fail("trust state encoding failed") }
    if existing {
        let status = SecItemUpdate(trustQuery() as CFDictionary, [kSecValueData: data] as CFDictionary)
        guard status == errSecSuccess else { fail("trust state update failed") }
    } else {
        var item = trustQuery()
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { fail("trust state enrollment failed") }
    }
}

private func trustCAS(_ request: Request) -> TrustState {
    requireAuthorizedAppCaller()
    guard let sequence = request.accepted_sequence, sequence >= 0, let attestationID = request.accepted_attestation_id, attestationID.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        fail("trust state successor is invalid")
    }
    return withTrustLock {
        let current = readTrust()
        if let current {
            guard request.expected_sequence == current.accepted_sequence, request.expected_attestation_id == current.accepted_attestation_id else {
                fail("trust state compare-and-swap rejected")
            }
            guard sequence == current.accepted_sequence + 1 else {
                fail("trust state sequence is not a direct successor")
            }
        } else {
            guard request.expected_sequence == nil, request.expected_attestation_id == nil, sequence == 0 else {
                fail("trust state initial compare-and-swap rejected")
            }
        }
        let next = TrustState(version: 1, key_id: publicKeyInfo().0, accepted_sequence: sequence, accepted_attestation_id: attestationID)
        writeTrust(next, replacing: current != nil)
        return next
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input) else { fail("request is malformed") }

switch request.operation {
case "enroll":
    requireAuthorizedAppCaller()
    let (keyID, publicKey) = enroll()
    let response = Response.ok(keyID: keyID, publicKey: publicKey)
    FileHandle.standardOutput.write(try! JSONEncoder().encode(response) + Data("\n".utf8))
case "key-info":
    requireAuthorizedAppCaller()
    let (keyID, publicKey) = publicKeyInfo()
    let response = Response.ok(keyID: keyID, publicKey: publicKey)
    FileHandle.standardOutput.write(try! JSONEncoder().encode(response) + Data("\n".utf8))
case "trust-read":
    requireAuthorizedAppCaller()
    let response = Response.ok(trust: readTrust())
    FileHandle.standardOutput.write(try! JSONEncoder().encode(response) + Data("\n".utf8))
case "trust-cas":
    let response = Response.ok(trust: trustCAS(request))
    FileHandle.standardOutput.write(try! JSONEncoder().encode(response) + Data("\n".utf8))
default:
    fail("unsupported operation")
}
