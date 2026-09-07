import XCTest
@testable import ReinKlaud

final class SSEDecoderTests: XCTestCase {
    func testParsesSplitMobileFrameAndDoneFrame() throws {
        var decoder = SSEDecoder()
        let first = Data("id: 1\nevent: rein.run.event\ndata: {\"sequence\":1,".utf8)
        let second = Data("\"event\":{\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\",\"delta\":\"hi\"}}\n\nevent: rein.run.done\ndata: {\"lastSequence\":1,\"status\":\"completed\"}\n\n".utf8)
        XCTAssertTrue(try decoder.append(first).isEmpty)
        let frames = try decoder.append(second, final: true)
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0].id, "1")
        XCTAssertEqual(frames[0].event, "rein.run.event")
        let envelope = try JSONDecoder().decode(MobileEventEnvelope.self, from: Data(frames[0].data.utf8))
        XCTAssertEqual(envelope.sequence, 1)
        XCTAssertEqual(envelope.event.textDelta, "hi")
        XCTAssertEqual(frames[1].event, "rein.run.done")
    }

    func testAcceptsCRLFAndMultilineData() throws {
        var decoder = SSEDecoder()
        let frames = try decoder.append(Data("event: note\r\ndata: first\r\ndata: second\r\n\r\n".utf8), final: true)
        XCTAssertEqual(frames, [SSEFrame(id: nil, event: "note", data: "first\nsecond")])
    }

    func testRejectsOversizedAndIncompleteFrames() throws {
        var small = SSEDecoder(maximumEventBytes: 4)
        XCTAssertThrowsError(try small.append(Data("12345".utf8)))
        var incomplete = SSEDecoder()
        XCTAssertThrowsError(try incomplete.append(Data("data: x".utf8), final: true))
    }
}
