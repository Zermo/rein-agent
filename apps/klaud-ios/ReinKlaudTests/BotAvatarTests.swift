import XCTest
@testable import ReinKlaud

final class BotAvatarTests: XCTestCase {
    func testOlderGatewayBotDecodesWithoutAnAvatar() throws {
        let data = Data(#"{"id":"bot-1","name":"Field Guide","sessionId":"thread-1"}"#.utf8)
        let bot = try JSONDecoder().decode(ReinBot.self, from: data)
        XCTAssertNil(bot.avatar)
        XCTAssertEqual(BotAvatarStyle.resolve(bot.avatar, botID: bot.id), .aviator)
    }

    func testExplicitAndUnknownAvatarsRemainCompatible() throws {
        let bot = ReinBot(id: "bot-1", name: "Field Guide", sessionId: "thread-1", avatar: "medic")
        XCTAssertEqual(try JSONDecoder().decode(ReinBot.self, from: JSONEncoder().encode(bot)), bot)
        XCTAssertEqual(BotAvatarStyle.resolve(bot.avatar, botID: bot.id), .medic)
        XCTAssertEqual(BotAvatarStyle.resolve("future-avatar", botID: bot.id), .aviator)
    }

    func testDeterministicFallbackMatchesDesktopCatalog() {
        // Golden vectors from avatar-catalog.mjs, including a Unicode bot identifier.
        XCTAssertEqual(BotAvatarStyle.resolve(nil, botID: ""), .motorcycle)
        XCTAssertEqual(BotAvatarStyle.resolve(nil, botID: "bot-1"), .aviator)
        XCTAssertEqual(BotAvatarStyle.resolve(nil, botID: "first-bot"), .explorer)
        XCTAssertEqual(BotAvatarStyle.resolve(nil, botID: "crew-🚀"), .explorer)
        XCTAssertEqual(BotAvatarStyle.resolve(nil, botID: String(repeating: "a", count: 4096) + "b"), .motorcycle)
    }
}
