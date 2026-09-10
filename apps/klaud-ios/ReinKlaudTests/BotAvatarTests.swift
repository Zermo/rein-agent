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

    func testMotionSeedsAndPoseMatchDesktopGoldenVectors() {
        XCTAssertEqual(AvatarMotion.seed(for: ""), 2166136261)
        XCTAssertEqual(AvatarMotion.seed(for: "bot-1"), 3391207752)
        XCTAssertEqual(AvatarMotion.seed(for: "crew-🚀"), 1882219613)
        // Sampled from avatar-motion.mjs at 2.5 seconds, with the bot-1 seed.
        let vectors: [(BotAvatarPhase, [Double])] = [
            (.working, [-1.1476926338454432, 0.6336779257324376, -1.7134999567168792, 1.0041131377337729, 0.9970312422183538, -0.22499685651944717, -0.0013558618279668592, -0.23623312840062993, -0.6727716768037858, -1.1389307266348878, -0.8442920298991707, 0.09473975088695621]),
            (.thinking, [-0.46550962737488766, -0.25286526630018086, -0.07623879276160325, 0.9968385664859298, 1.003074638237325, 0.0547217976279102, -0.18068141635529103, 0.20486773324993818, 0.49973331491687795, 0.07129629976047179, -0.1903150513162666, 1.7065372262111538]),
            (.responding, [-0.27764649978698286, 1.1182780219292496, -1.282381319036144, 1.0142303097574703, 0.9884054549024678, -0.10351115798646146, 0.4113829069461, -0.46363615396982394, 0.20865858621518718, -0.048644068940847496, 0.02063044055647706, -1.7733057260978342]),
            (.tool, [0.4850950783066744, -0.8500080266093764, 0.3372449354880247, 0.9955487207591586, 1.0037743008529003, 0.2886275019867806, -0.27177235709423153, 0.031115903635637404, -0.38671737049029004, 0.9740630316076888, 0.1665920785098743, -0.016324331595114094]),
            (.journaling, [-1.007777014533816, -0.09184467999166818, -1.0064343530030433, 0.9983199402686059, 1.0019487506342135, -0.14347160854361346, -0.2107882444480875, -0.060168630405981, -0.7062709593494816, -1.1035744194734365, -0.8947867101312752, 1.0467292169640046]),
            (.autonomy, [0.2803038059564897, 0.003500203115230971, 0.673401543775421, 0.9986177524030069, 1.0015961174146204, 0.19627483471819057, 0.05064770276560613, 0.3429134042624064, 0.8531897724078268, 0.8395439040945419, 0.27114868461431185, 0.589042542102434]),
        ]
        for (phase, expected) in vectors {
            let pose = AvatarMotion.pose(seconds: 2.5, phase: phase, seed: AvatarMotion.seed(for: "bot-1"))
            for (key, value) in zip(AvatarPose.fields, expected) { XCTAssertEqual(pose[keyPath: key], value, accuracy: 1e-12, phase.rawValue) }
        }
    }

    func testOnlyReportedWorkingStatesMove() {
        for phase in [BotAvatarPhase.ready, .approval, .error] {
            XCTAssertFalse(phase.moves)
            XCTAssertEqual(AvatarMotion.pose(seconds: 1e6, phase: phase, seed: 42), .neutral)
        }
        for phase in BotAvatarPhase.allCases where phase.moves {
            let first = AvatarMotion.pose(seconds: 1, phase: phase, seed: 42)
            let second = AvatarMotion.pose(seconds: 2, phase: phase, seed: 42)
            XCTAssertNotEqual(first, second)
            XCTAssertNotEqual(first, AvatarMotion.pose(seconds: 1, phase: phase, seed: 43))
            for key in AvatarPose.fields { XCTAssertTrue(first[keyPath: key].isFinite) }
        }
    }

    func testDampingHasSameFixedTargetResponseAtDifferentFrameRates() {
        let target = AvatarMotion.pose(seconds: 2.5, phase: .thinking, seed: 42)
        func sample(rate: Int) -> AvatarPose {
            (0..<rate).reduce(.neutral) { pose, _ in AvatarMotion.damp(pose, toward: target, delta: 1.0 / Double(rate)) }
        }
        for key in AvatarPose.fields {
            XCTAssertEqual(sample(rate: 30)[keyPath: key], sample(rate: 60)[keyPath: key], accuracy: 1e-12)
            XCTAssertEqual(sample(rate: 60)[keyPath: key], sample(rate: 120)[keyPath: key], accuracy: 1e-12)
        }
        XCTAssertEqual(AvatarMotion.damp(.neutral, toward: target, delta: .nan), .neutral)
        XCTAssertEqual(AvatarMotion.damp(.neutral, toward: target, delta: -1), .neutral)
        XCTAssertEqual(AvatarMotion.damp(.neutral, toward: target, delta: 60), AvatarMotion.damp(.neutral, toward: target, delta: 0.05))
    }

    func testMotionStopsForIdleReducedMotionAndHiddenLifecycle() {
        var motion = AvatarMotionState()
        XCTAssertFalse(motion.shouldTick(phase: .ready, visible: true, sceneActive: true, reduceMotion: false))
        XCTAssertTrue(motion.shouldTick(phase: .working, visible: true, sceneActive: true, reduceMotion: false))
        XCTAssertFalse(motion.shouldTick(phase: .working, visible: false, sceneActive: true, reduceMotion: false))
        XCTAssertFalse(motion.shouldTick(phase: .working, visible: true, sceneActive: false, reduceMotion: false))
        XCTAssertFalse(motion.shouldTick(phase: .working, visible: true, sceneActive: true, reduceMotion: true))
        motion.advance(at: 0, phase: .working, seed: 42)
        motion.advance(at: 0.04, phase: .working, seed: 42)
        let frozen = motion.pose, elapsed = motion.elapsed
        motion.suspend()
        motion.advance(at: 600, phase: .working, seed: 42)
        XCTAssertEqual(motion.pose, frozen)
        XCTAssertEqual(motion.elapsed, elapsed)
        motion.suspend(reset: true)
        XCTAssertEqual(motion.pose, .neutral)
    }

    func testMotionSettlesAndUnschedulesAfterWorkEnds() {
        for stoppingPhase in [BotAvatarPhase.ready, .approval, .error] {
            var motion = AvatarMotionState()
            for frame in 0..<60 { motion.advance(at: Double(frame) / 60, phase: .responding, seed: 42) }
            XCTAssertFalse(motion.pose.isNeutral)
            XCTAssertTrue(motion.shouldTick(phase: stoppingPhase, visible: true, sceneActive: true, reduceMotion: false))
            for frame in 60..<120 { motion.advance(at: Double(frame) / 60, phase: stoppingPhase, seed: 42) }
            XCTAssertEqual(motion.pose, .neutral)
            XCTAssertFalse(motion.shouldTick(phase: stoppingPhase, visible: true, sceneActive: true, reduceMotion: false))
        }
    }

    func testPublicProgressValidatesPhaseAndTurnWithoutInspectingThoughts() throws {
        func decode(_ json: String) throws -> BotAvatarPhase? {
            BotAvatarPhase.reported(by: try JSONDecoder().decode(GatewayEvent.self, from: Data(json.utf8)))
        }
        XCTAssertEqual(try decode(#"{"type":"CUSTOM","name":"klaud.progress","value":{"phase":"thinking","turn":2}}"#), .thinking)
        XCTAssertEqual(try decode(#"{"type":"CUSTOM","name":"klaud.progress","value":{"phase":"journaling","turn":2}}"#), .journaling)
        XCTAssertEqual(try decode(#"{"type":"CUSTOM","name":"klaud.progress","value":{"phase":"autonomy","turn":2}}"#), .autonomy)
        for value in [#"{"phase":"thinking","turn":0}"#, #"{"phase":"thinking","turn":1.5}"#, #"{"phase":"thinking"}"#, #"{"phase":"happy","turn":1}"#, #"{"phase":"approval","turn":1}"#] {
            XCTAssertNil(try decode("{\"type\":\"CUSTOM\",\"name\":\"klaud.progress\",\"value\":\(value)}"))
        }
        XCTAssertNil(try decode(#"{"type":"CUSTOM","name":"future.event","value":{"phase":"thinking","turn":1}}"#))
    }
}
