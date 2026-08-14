import CryptoKit
import Foundation
import Security
import Darwin

private let keyTag = "com.jeremywinchester.mnemosyne.snapshot.signing.v1"
private let trustService = "com.jeremywinchester.mnemosyne.snapshot.trust.v1"
private let trustAccount = "device"
private let appIdentifier = "com.jeremywinchester.mnemosyne"
private let helperIdentifier = "com.jeremywinchester.mnemosyne.trust-helper"

struct Request: Codable {
    let operation: String
    let payload_base64: String?
    let expected_sequence: Int?
    let expected_attestation_id: String?
    let accepted_sequence: Int?
    let accepted_attestation_id: String?
    let generation: String?
    let sequence: Int?
    let previous_attestation_sha256: String?
    let fields: Set<String>

    private struct CodingKeyName: CodingKey {
        let stringValue: String
        let intValue: Int? = nil

        init(_ stringValue: String) { self.stringValue = stringValue }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeyName.self)
        let allowed = Set([
            "operation", "payload_base64", "expected_sequence", "expected_attestation_id",
            "accepted_sequence", "accepted_attestation_id", "generation", "sequence",
            "previous_attestation_sha256"
        ])
        let fields = Set(container.allKeys.map { $0.stringValue })
        guard fields.isSubset(of: allowed) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "request contains unknown fields"))
        }
        self.operation = try container.decode(String.self, forKey: CodingKeyName("operation"))
        self.payload_base64 = try container.decodeIfPresent(String.self, forKey: CodingKeyName("payload_base64"))
        self.expected_sequence = try container.decodeIfPresent(Int.self, forKey: CodingKeyName("expected_sequence"))
        self.expected_attestation_id = try container.decodeIfPresent(String.self, forKey: CodingKeyName("expected_attestation_id"))
        self.accepted_sequence = try container.decodeIfPresent(Int.self, forKey: CodingKeyName("accepted_sequence"))
        self.accepted_attestation_id = try container.decodeIfPresent(String.self, forKey: CodingKeyName("accepted_attestation_id"))
        self.generation = try container.decodeIfPresent(String.self, forKey: CodingKeyName("generation"))
        self.sequence = try container.decodeIfPresent(Int.self, forKey: CodingKeyName("sequence"))
        self.previous_attestation_sha256 = try container.decodeIfPresent(String.self, forKey: CodingKeyName("previous_attestation_sha256"))
        self.fields = fields
    }

    init(operation: String, payload_base64: String? = nil, expected_sequence: Int? = nil, expected_attestation_id: String? = nil, accepted_sequence: Int? = nil, accepted_attestation_id: String? = nil, generation: String? = nil, sequence: Int? = nil, previous_attestation_sha256: String? = nil, fields: Set<String> = []) {
        self.operation = operation
        self.payload_base64 = payload_base64
        self.expected_sequence = expected_sequence
        self.expected_attestation_id = expected_attestation_id
        self.accepted_sequence = accepted_sequence
        self.accepted_attestation_id = accepted_attestation_id
        self.generation = generation
        self.sequence = sequence
        self.previous_attestation_sha256 = previous_attestation_sha256
        self.fields = fields
    }
}

struct TrustState: Codable {
    let version: Int
    let key_id: String
    let accepted_sequence: Int
    let accepted_attestation_id: String
}

struct Response: Codable {
    let status: String
    let key_id: String?
    let public_key_pem: String?
    let signature_base64: String?
    let payload: CandidatePayload?
    let signature_algorithm: String?
    let signature: String?
    let trust_state: TrustState?
    let error: String?

    static func ok(keyID: String? = nil, publicKey: String? = nil, signatureBase64: String? = nil, payload: CandidatePayload? = nil, signatureAlgorithm: String? = nil, signature: String? = nil, trust: TrustState? = nil) -> Response {
        Response(status: "ok", key_id: keyID, public_key_pem: publicKey, signature_base64: signatureBase64, payload: payload, signature_algorithm: signatureAlgorithm, signature: signature, trust_state: trust, error: nil)
    }

    static func failure(_ message: String) -> Response {
        Response(status: "error", key_id: nil, public_key_pem: nil, signature_base64: nil, payload: nil, signature_algorithm: nil, signature: nil, trust_state: nil, error: message)
    }
}

func fail(_ message: String) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(Response.failure(message)), let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    }
    exit(1)
}

func writeResponse(_ response: Response) {
    guard let data = try? JSONEncoder().encode(response) else { fail("response encoding failed") }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func base64(_ data: Data) -> String { data.base64EncodedString() }

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func keyTagData() -> Data { Data(keyTag.utf8) }

private func secureEnclaveKeyURL() -> URL {
    let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Mnemosyne", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    } catch { fail("secure enclave key directory unavailable") }
    return directory.appendingPathComponent("secure-enclave-signing-key.dat", isDirectory: false)
}

func findPrivateKey() -> SecureEnclave.P256.Signing.PrivateKey {
    let url = secureEnclaveKeyURL()
    guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
        fail("secure enclave signing key is not enrolled")
    }
    do {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
    } catch { fail("secure enclave signing key is unreadable") }
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

func p256SPKI(_ raw: Data) -> Data {
    guard raw.count == 65, raw.first == 0x04 else {
        fail("secure enclave public key export failed")
    }
    let prefix = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
    return prefix + raw
}

private func publicKeyInfo() -> (String, String) {
    let privateKey = findPrivateKey()
    let pemData = p256SPKI(privateKey.publicKey.x963Representation)
    let keyID = sha256Hex(pemData)
    let base64 = pemData.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        .trimmingCharacters(in: .newlines)
    let pem = "-----BEGIN PUBLIC KEY-----\n\(base64)\n-----END PUBLIC KEY-----\n"
    return (keyID, pem)
}

private func enroll() -> (String, String) {
    let url = secureEnclaveKeyURL()
    if FileManager.default.fileExists(atPath: url.path) { return publicKeyInfo() }
    let privateKey: SecureEnclave.P256.Signing.PrivateKey
    do { privateKey = try SecureEnclave.P256.Signing.PrivateKey() }
    catch { fail("secure enclave key enrollment failed") }
    do {
        try privateKey.dataRepresentation.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    } catch { fail("secure enclave key reference persistence failed") }
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

private func runSecurity(_ arguments: [String], allowNotFound: Bool = false) -> Data? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    process.arguments = arguments
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    do { try process.run() } catch { fail("Keychain security command unavailable") }
    process.waitUntilExit()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let errorData = errors.fileHandleForReading.readDataToEndOfFile()
    guard data.count <= 64 * 1024, errorData.count <= 64 * 1024 else { fail("Keychain security command output exceeded limit") }
    if allowNotFound && process.terminationStatus == 44 { return nil }
    guard process.terminationReason == .exit && process.terminationStatus == 0 else { fail("Keychain security command failed") }
    return data
}

private func readTrust() -> TrustState? {
    guard let data = runSecurity(["find-generic-password", "-s", trustService, "-a", trustAccount, "-w"], allowNotFound: true) else { return nil }
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
    guard let value = String(data: data, encoding: .utf8) else { fail("trust state encoding failed") }
    _ = existing
    _ = runSecurity(["add-generic-password", "-U", "-s", trustService, "-a", trustAccount, "-w", value])
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

struct CandidatePayload: Codable {
    let domain: String
    let schema_version: Int
    let generation: String
    let sequence: Int
    let created_at: String
    let manifest_sha256: String
    let authority_sha256: String
    let wikimap_index_sha256: String
    let previous_attestation_sha256: String?

    private enum CodingKeys: String, CodingKey {
        case domain, schema_version, generation, sequence, created_at
        case manifest_sha256, authority_sha256, wikimap_index_sha256, previous_attestation_sha256
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(domain, forKey: .domain)
        try container.encode(schema_version, forKey: .schema_version)
        try container.encode(generation, forKey: .generation)
        try container.encode(sequence, forKey: .sequence)
        try container.encode(created_at, forKey: .created_at)
        try container.encode(manifest_sha256, forKey: .manifest_sha256)
        try container.encode(authority_sha256, forKey: .authority_sha256)
        try container.encode(wikimap_index_sha256, forKey: .wikimap_index_sha256)
        if let previous_attestation_sha256 {
            try container.encode(previous_attestation_sha256, forKey: .previous_attestation_sha256)
        } else {
            try container.encodeNil(forKey: .previous_attestation_sha256)
        }
    }
}

struct ManifestEntry: Decodable {
    let relative_path: String
    let sha256: String
    let size: Int
    let state: String
}

struct Manifest: Decodable {
    let schema_version: Int
    let generation: String
    let created_at: String
    let file_count: Int
    let files: [ManifestEntry]
}

struct AuthorityEntry: Decodable {
    let relative_path: String
    let tier: String
    let wiki_schema: String?
    let layer: String?
    let domain: String?
    let source_role: String?
    let authority: String?
    let status: String?
    let do_not_answer_as_current: Bool?
    let last_verified: String?
    let canonical_path: String?
    let redirect_reason: String?
    let has_frontmatter: Bool
}

struct UnresolvedRedirect: Decodable, Hashable {
    let from: String
    let to: String
    let reason: String
}

struct Authority: Decodable {
    let schema_version: Int
    let generation: String
    let tier_counts: [String: Int]
    let redirect_map: [String: String]
    let unresolved_redirects: [UnresolvedRedirect]
    let entries: [AuthorityEntry]
}

private let fixedProjectionComponents = ["Library", "Application Support", "Mnemosyne", "fixed-projection"]
private let maxManifestBytes = 16 * 1024 * 1024
private let maxAuthorityBytes = 64 * 1024 * 1024
private let maxIndexBytes = 1024 * 1024 * 1024
private let maxDocumentBytes = 2 * 1024 * 1024
private let readChunkBytes = 1024 * 1024

private func fixedProjectionHomeComponents() -> [String] {
#if MNEMOSYNE_ATTESTOR_TEST
    guard let home = ProcessInfo.processInfo.environment["MNEMOSYNE_ATTESTOR_TEST_HOME"], home.hasPrefix("/") else {
        fail("test fixed projection home is unavailable")
    }
    let components = home.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !components.isEmpty, components.allSatisfy({ $0 != "." && $0 != ".." }) else {
        fail("test fixed projection home is unsafe")
    }
    return components
#else
    return NSHomeDirectory().split(separator: "/", omittingEmptySubsequences: true).map(String.init)
#endif
}

private func failDecode(_ label: String) -> Never {
    fail("\(label) is malformed")
}

private func openDirectory(_ parent: Int32, _ name: String, _ label: String) -> Int32 {
    let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard fd >= 0 else { fail("\(label) is missing or unsafe") }
    return fd
}

private func openFixedProjectionRoot() -> Int32 {
    let homeComponents = fixedProjectionHomeComponents()
    var fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard fd >= 0 else { fail("fixed projection root is unavailable") }
    for component in homeComponents + fixedProjectionComponents {
        let next = openDirectory(fd, component, "fixed projection root")
        close(fd)
        fd = next
    }
    return fd
}

private func fileFingerprint(_ fd: Int32, _ label: String) -> stat {
    var info = stat()
    guard fstat(fd, &info) == 0 else { fail("\(label) metadata is unreadable") }
    return info
}

private func sameFingerprint(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev &&
        left.st_ino == right.st_ino &&
        left.st_size == right.st_size &&
        left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec &&
        left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec
}

private func openRegularFile(_ parent: Int32, _ components: [String], _ label: String) -> (Int32, [Int32]) {
    guard let last = components.last, !last.isEmpty else { fail("\(label) path is empty") }
    var directory = parent
    var openedDirectories: [Int32] = []
    for component in components.dropLast() {
        let next = openDirectory(directory, component, label)
        openedDirectories.append(next)
        directory = next
    }
    let fd = openat(directory, last, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else {
        openedDirectories.reversed().forEach { close($0) }
        fail("\(label) is missing or unsafe")
    }
    return (fd, openedDirectories)
}

private func readStableFile(
    _ parent: Int32,
    _ components: [String],
    minimumBytes: Int = 0,
    maximumBytes: Int,
    _ label: String
) -> Data {
    let (fd, openedDirectories) = openRegularFile(parent, components, label)
    defer {
        close(fd)
        openedDirectories.reversed().forEach { close($0) }
    }
    let before = fileFingerprint(fd, label)
    guard before.st_mode & S_IFMT == S_IFREG else { fail("\(label) is not a regular file") }
    guard before.st_size >= off_t(minimumBytes), before.st_size <= off_t(maximumBytes), before.st_size <= off_t(Int.max) else {
        fail("\(label) is outside the size limits")
    }
    let expectedSize = Int(before.st_size)
    var bytes = Data()
    bytes.reserveCapacity(expectedSize)
    var remaining = expectedSize
    var chunk = [UInt8](repeating: 0, count: min(readChunkBytes, max(1, expectedSize)))
    while remaining > 0 {
        let count = chunk.withUnsafeMutableBytes { rawBuffer -> Int in
            guard let address = rawBuffer.baseAddress else { return -1 }
            return Darwin.read(fd, address, min(rawBuffer.count, remaining))
        }
        guard count > 0 else { fail("\(label) changed while reading") }
        bytes.append(contentsOf: chunk.prefix(count))
        remaining -= count
    }
    var probe: UInt8 = 0
    guard Darwin.read(fd, &probe, 1) == 0 else { fail("\(label) changed while reading") }
    let after = fileFingerprint(fd, label)
    guard sameFingerprint(before, after) else { fail("\(label) changed while reading") }
    return bytes
}

private func jsonDictionary(_ data: Data, _ label: String) -> [String: Any] {
    guard hasUniqueJSONKeys(data) else { failDecode(label) }
    guard let object = try? JSONSerialization.jsonObject(with: data), let dictionary = object as? [String: Any] else {
        failDecode(label)
    }
    return dictionary
}

private struct StrictJSONScanner {
    let bytes: [UInt8]
    var offset = 0

    mutating func scan() -> Bool {
        skipWhitespace()
        guard scanValue() else { return false }
        skipWhitespace()
        return offset == bytes.count
    }

    mutating private func skipWhitespace() {
        while offset < bytes.count && [0x20, 0x09, 0x0a, 0x0d].contains(bytes[offset]) { offset += 1 }
    }

    mutating private func scanValue() -> Bool {
        skipWhitespace()
        guard offset < bytes.count else { return false }
        switch bytes[offset] {
        case 0x7b: return scanObject()
        case 0x5b: return scanArray()
        case 0x22: return scanString() != nil
        case 0x74: return scanLiteral("true")
        case 0x66: return scanLiteral("false")
        case 0x6e: return scanLiteral("null")
        default: return scanNumber()
        }
    }

    mutating private func scanObject() -> Bool {
        offset += 1
        skipWhitespace()
        if offset < bytes.count && bytes[offset] == 0x7d { offset += 1; return true }
        var keys = Set<String>()
        while true {
            skipWhitespace()
            guard let key = scanString(), keys.insert(key).inserted else { return false }
            skipWhitespace()
            guard offset < bytes.count && bytes[offset] == 0x3a else { return false }
            offset += 1
            guard scanValue() else { return false }
            skipWhitespace()
            guard offset < bytes.count else { return false }
            if bytes[offset] == 0x7d { offset += 1; return true }
            guard bytes[offset] == 0x2c else { return false }
            offset += 1
        }
    }

    mutating private func scanArray() -> Bool {
        offset += 1
        skipWhitespace()
        if offset < bytes.count && bytes[offset] == 0x5d { offset += 1; return true }
        while true {
            guard scanValue() else { return false }
            skipWhitespace()
            guard offset < bytes.count else { return false }
            if bytes[offset] == 0x5d { offset += 1; return true }
            guard bytes[offset] == 0x2c else { return false }
            offset += 1
        }
    }

    mutating private func scanString() -> String? {
        guard offset < bytes.count && bytes[offset] == 0x22 else { return nil }
        let start = offset
        offset += 1
        var escaped = false
        while offset < bytes.count {
            let byte = bytes[offset]
            offset += 1
            if escaped { escaped = false; continue }
            if byte == 0x5c { escaped = true; continue }
            if byte == 0x22 {
                let data = Data(bytes[start..<offset])
                return (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) as? String
            }
            if byte < 0x20 { return nil }
        }
        return nil
    }

    mutating private func scanLiteral(_ literal: String) -> Bool {
        let target = Array(literal.utf8)
        guard offset + target.count <= bytes.count, Array(bytes[offset..<(offset + target.count)]) == target else { return false }
        offset += target.count
        return true
    }

    mutating private func scanNumber() -> Bool {
        let start = offset
        while offset < bytes.count && ![0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x5d, 0x7d].contains(bytes[offset]) { offset += 1 }
        guard offset > start else { return false }
        let data = Data(bytes[start..<offset])
        return (try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)) is NSNumber
    }
}

private func hasUniqueJSONKeys(_ data: Data) -> Bool {
    var scanner = StrictJSONScanner(bytes: Array(data))
    return scanner.scan()
}

func decodeStrictRequest(_ data: Data) -> Request? {
    guard hasUniqueJSONKeys(data) else { return nil }
    return try? JSONDecoder().decode(Request.self, from: data)
}

private func decodeManifest(_ data: Data) -> Manifest {
    let dictionary = jsonDictionary(data, "manifest.json")
    let expectedKeys = Set(["schema_version", "generation", "created_at", "file_count", "files"])
    guard Set(dictionary.keys) == expectedKeys, let rawFiles = dictionary["files"] as? [[String: Any] ] else {
        failDecode("manifest.json")
    }
    let expectedFileKeys = Set(["relative_path", "sha256", "size", "state"])
    guard rawFiles.allSatisfy({ Set($0.keys) == expectedFileKeys }) else { failDecode("manifest.json") }
    guard let manifest = try? JSONDecoder().decode(Manifest.self, from: data), manifest.schema_version == 2 else {
        failDecode("manifest.json")
    }
    guard manifest.file_count == manifest.files.count else { fail("manifest file count is inconsistent") }
    return manifest
}

private func decodeAuthority(_ data: Data) -> Authority {
    let dictionary = jsonDictionary(data, "authority.json")
    let expectedKeys = Set(["schema_version", "generation", "tier_counts", "redirect_map", "unresolved_redirects", "entries"])
    guard Set(dictionary.keys) == expectedKeys,
          dictionary["tier_counts"] is [String: Any],
          dictionary["redirect_map"] is [String: Any],
          let unresolved = dictionary["unresolved_redirects"] as? [[String: Any]],
          let entries = dictionary["entries"] as? [[String: Any]],
          unresolved.allSatisfy({ Set($0.keys) == Set(["from", "to", "reason"]) }),
          entries.allSatisfy({ entry in
              let required = Set(["relative_path", "tier", "has_frontmatter"])
              let allowed = required.union(["wiki_schema", "layer", "domain", "source_role", "authority", "status", "do_not_answer_as_current", "last_verified", "canonical_path", "redirect_reason"])
              let stringFields = ["relative_path", "tier", "wiki_schema", "layer", "domain", "source_role", "authority", "status", "last_verified", "canonical_path", "redirect_reason"]
              return required.isSubset(of: Set(entry.keys)) && Set(entry.keys).isSubset(of: allowed)
                  && stringFields.allSatisfy({ entry[$0] == nil || entry[$0] is String })
                  && entry["has_frontmatter"] is Bool
                  && (entry["do_not_answer_as_current"] == nil || entry["do_not_answer_as_current"] is Bool)
          }),
          let authority = try? JSONDecoder().decode(Authority.self, from: data), authority.schema_version == 1 else {
        failDecode("authority.json")
    }
    return authority
}

private func isSha256(_ value: String) -> Bool {
    value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
}

func validatedRelativePath(_ value: String) -> [String] {
    guard !value.isEmpty, value == value.precomposedStringWithCanonicalMapping,
          !value.hasPrefix("/"), !value.contains("\\"), value.lowercased().hasSuffix(".md") else {
        fail("manifest document path is unsafe")
    }
    let components = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
          components.first == "brain" || components.first == "domains" else {
        fail("manifest document path is unsafe")
    }
    return components
}

func requestInputs(_ request: Request) -> (generation: String, sequence: Int, previous: String?) {
    let expectedFields = Set(["operation", "generation", "sequence", "previous_attestation_sha256"])
    guard request.operation == "attest-candidate", request.fields == expectedFields,
          let generation = request.generation, generation.range(of: "^[A-Za-z0-9._-]{1,160}$", options: .regularExpression) != nil,
          generation != ".", generation != "..",
          let sequence = request.sequence, sequence >= 0, sequence <= 9_007_199_254_740_991,
          request.previous_attestation_sha256 == nil || isSha256(request.previous_attestation_sha256 ?? "") else {
        fail("attest-candidate request is invalid")
    }
    return (generation, sequence, request.previous_attestation_sha256)
}

func canonicalPayload(_ payload: CandidatePayload) -> Data {
    let previous = payload.previous_attestation_sha256.map { "\"\($0)\"" } ?? "null"
    let json = "{\"authority_sha256\":\"\(payload.authority_sha256)\",\"created_at\":\"\(payload.created_at)\",\"domain\":\"\(payload.domain)\",\"generation\":\"\(payload.generation)\",\"manifest_sha256\":\"\(payload.manifest_sha256)\",\"previous_attestation_sha256\":\(previous),\"schema_version\":\(payload.schema_version),\"sequence\":\(payload.sequence),\"wikimap_index_sha256\":\"\(payload.wikimap_index_sha256)\"}"
    return Data("\(payload.domain)\0\(json)".utf8)
}

private func foldedPath(_ value: String) -> String {
    value.folding(options: [.caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
}

private func validateManifest(_ manifest: Manifest, generation: Int32) {
    var exact = Set<String>()
    var folded = Set<String>()
    var previousPath: String?
    for entry in manifest.files {
        _ = validatedRelativePath(entry.relative_path)
        guard exact.insert(entry.relative_path).inserted,
              folded.insert(foldedPath(entry.relative_path)).inserted,
              previousPath == nil || previousPath! < entry.relative_path else {
            fail("manifest document paths are non-canonical")
        }
        previousPath = entry.relative_path
        switch entry.state {
        case "copied":
            guard isSha256(entry.sha256), entry.size >= 0, entry.size <= maxDocumentBytes else {
                fail("manifest copied document entry is invalid")
            }
        case "deleted":
            guard entry.sha256 == String(repeating: "0", count: 64), entry.size == 0 else {
                fail("manifest deleted tombstone is invalid")
            }
            ensureDocumentMissing(generation, validatedRelativePath(entry.relative_path))
        default:
            fail("manifest document state is invalid")
        }
    }
}

private func ensureDocumentMissing(_ generation: Int32, _ components: [String]) {
    guard let last = components.last else { fail("manifest document path is unsafe") }
    var directory = generation
    var opened: [Int32] = []
    defer { opened.reversed().forEach { close($0) } }
    for component in components.dropLast() {
        let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if next < 0 {
            guard errno == ENOENT else { fail("deleted document path is unsafe") }
            return
        }
        opened.append(next)
        directory = next
    }
    let fd = openat(directory, last, O_RDONLY | O_NOFOLLOW)
    if fd >= 0 { close(fd); fail("deleted tombstone still has document bytes") }
    guard errno == ENOENT else { fail("deleted document path is unsafe") }
}

private func normalizedRedirectTarget(_ value: String) -> String {
    let stripped = value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let target = stripped.lowercased().hasSuffix(".md") ? stripped : "\(stripped).md"
    _ = validatedRelativePath(target)
    return target
}

private func validateAuthority(_ authority: Authority, manifest: Manifest) {
    let validTiers = Set(["current", "authority", "redirect", "raw", "index", "history", "unknown", "draft"])
    guard Set(authority.tier_counts.keys).isSubset(of: validTiers), authority.tier_counts.values.allSatisfy({ $0 >= 0 }) else {
        fail("authority tier counts are invalid")
    }
    var computedCounts: [String: Int] = [:]
    var computedRedirects: [String: String] = [:]
    var paths = Set<String>()
    var folded = Set<String>()
    var previousPath: String?
    for entry in authority.entries {
        _ = validatedRelativePath(entry.relative_path)
        guard validTiers.contains(entry.tier), paths.insert(entry.relative_path).inserted,
              folded.insert(foldedPath(entry.relative_path)).inserted,
              previousPath == nil || previousPath! < entry.relative_path else {
            fail("authority entries are inconsistent")
        }
        previousPath = entry.relative_path
        computedCounts[entry.tier, default: 0] += 1
        if entry.tier == "redirect" {
            // Dobby classifies do_not_answer_as_current evidence ledgers as
            // redirect-tier even when they are not path aliases. Only entries
            // carrying canonical_path participate in redirect_map.
            if let destination = entry.canonical_path {
                _ = normalizedRedirectTarget(destination)
                computedRedirects[entry.relative_path] = destination
            }
        }
    }
    let copiedPaths = Set(manifest.files.filter({ $0.state == "copied" }).map({ $0.relative_path }))
    guard paths == copiedPaths, computedCounts == authority.tier_counts, computedRedirects == authority.redirect_map else {
        fail("authority manifest is inconsistent with copied documents")
    }
    let expectedUnresolved = Set(computedRedirects.compactMap { source, destination -> UnresolvedRedirect? in
        let target = normalizedRedirectTarget(destination)
        guard !copiedPaths.contains(destination.trimmingCharacters(in: CharacterSet(charactersIn: "/"))), !copiedPaths.contains(target) else { return nil }
        return UnresolvedRedirect(from: source, to: destination, reason: "canonical_path target not found in snapshot")
    })
    guard Set(authority.unresolved_redirects) == expectedUnresolved,
          authority.unresolved_redirects.count == expectedUnresolved.count else {
        fail("authority unresolved redirects are inconsistent")
    }
}

func validatedCandidatePayload(_ request: Request, createdAt: String) -> CandidatePayload {
    let inputs = requestInputs(request)
    let root = openFixedProjectionRoot()
    defer { close(root) }
    let snapshots = openDirectory(root, "snapshots", "fixed projection snapshots")
    defer { close(snapshots) }
    let generation = openDirectory(snapshots, inputs.generation, "fixed projection generation")
    defer { close(generation) }

    let manifestBytes = readStableFile(generation, ["manifest.json"], maximumBytes: maxManifestBytes, "manifest.json")
    let manifest = decodeManifest(manifestBytes)
    guard manifest.generation == inputs.generation else { fail("manifest generation mismatch") }
    validateManifest(manifest, generation: generation)
    let authorityBytes = readStableFile(generation, ["authority.json"], maximumBytes: maxAuthorityBytes, "authority.json")
    let authority = decodeAuthority(authorityBytes)
    guard authority.generation == inputs.generation else { fail("authority generation mismatch") }
    validateAuthority(authority, manifest: manifest)
    let indexBytes = readStableFile(
        generation,
        [".wikimap", "index.db"],
        minimumBytes: 1,
        maximumBytes: maxIndexBytes,
        ".wikimap/index.db"
    )

    for entry in manifest.files where entry.state == "copied" {
        let document = readStableFile(generation, validatedRelativePath(entry.relative_path), maximumBytes: maxDocumentBytes, "copied document")
        guard document.count == entry.size, sha256Hex(document) == entry.sha256 else { fail("copied document digest mismatch") }
    }

    let payload = CandidatePayload(
        domain: "MNEMOSYNE-SNAPSHOT-ATTESTATION-V1",
        schema_version: 1,
        generation: inputs.generation,
        sequence: inputs.sequence,
        created_at: createdAt,
        manifest_sha256: sha256Hex(manifestBytes),
        authority_sha256: sha256Hex(authorityBytes),
        wikimap_index_sha256: sha256Hex(indexBytes),
        previous_attestation_sha256: inputs.previous
    )
    return payload
}

func attestCandidate(_ request: Request) -> Response {
    let payload = validatedCandidatePayload(request, createdAt: ISO8601DateFormatter().string(from: Date()))
    let canonical = canonicalPayload(payload)
    let privateKey = findPrivateKey()
    let signature: P256.Signing.ECDSASignature
    do { signature = try privateKey.signature(for: canonical) }
    catch { fail("secure enclave signing failed") }
    let keyID = sha256Hex(p256SPKI(privateKey.publicKey.x963Representation))
    return Response.ok(keyID: keyID, payload: payload, signatureAlgorithm: "ECDSA_P256_SHA256", signature: base64(signature.derRepresentation))
}


private func runMain() {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = decodeStrictRequest(input) else { fail("request is malformed") }

    switch request.operation {
    case "enroll":
        requireAuthorizedAppCaller()
        let (keyID, publicKey) = enroll()
        let response = Response.ok(keyID: keyID, publicKey: publicKey)
        writeResponse(response)
    case "key-info":
        requireAuthorizedAppCaller()
        let (keyID, publicKey) = publicKeyInfo()
        let response = Response.ok(keyID: keyID, publicKey: publicKey)
        writeResponse(response)
    case "trust-read":
        requireAuthorizedAppCaller()
        let response = Response.ok(trust: readTrust())
        writeResponse(response)
    case "trust-cas":
        let response = Response.ok(trust: trustCAS(request))
        writeResponse(response)
    case "attest-candidate":
        requireAuthorizedAppCaller()
        writeResponse(attestCandidate(request))
    default:
        fail("unsupported operation")
    }
}

#if MNEMOSYNE_ATTESTOR_TEST
runFixedRootAttestorTestHarness()
#else
runMain()
#endif
