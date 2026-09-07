import XCTest
@testable import ReinKlaud

final class ReplyPresentationTests: XCTestCase {
    func testExactFirstLineMarkersBecomeLabelsAndLeaveTheBody() {
        for purpose in ReplyPurpose.allCases where purpose != .message {
            let parsed = ReplyPresentation.parse("[\(purpose.rawValue)]\r\nBody text")
            XCTAssertEqual(parsed, .init(pending: false, purpose: purpose, text: "Body text"))
        }
    }

    func testNearMatchesRemainOrdinaryMessageText() {
        for text in ["prefix [RESULT]\nBody", "[result]\nBody", "[RESULT] extra\nBody"] {
            XCTAssertEqual(ReplyPresentation.parse(text).purpose, .message)
            XCTAssertEqual(ReplyPresentation.parse(text).text, text)
        }
    }

    func testPartialMarkerWaitsOnlyWhileStreaming() {
        XCTAssertTrue(ReplyPresentation.parse("[RES", final: false).pending)
        XCTAssertFalse(ReplyPresentation.parse("[RES", final: true).pending)
    }
}
