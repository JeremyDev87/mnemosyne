import Foundation

private struct HarnessResponse: Encodable {
    let payload: CandidatePayload
    let canonical_base64: String
}

func runFixedRootAttestorTestHarness() {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = decodeStrictRequest(input) else { fail("request is malformed") }
    let payload = validatedCandidatePayload(request, createdAt: "2026-08-11T00:00:01Z")
    let response = HarnessResponse(payload: payload, canonical_base64: canonicalPayload(payload).base64EncodedString())
    guard let data = try? JSONEncoder().encode(response) else { fail("test harness response encoding failed") }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
