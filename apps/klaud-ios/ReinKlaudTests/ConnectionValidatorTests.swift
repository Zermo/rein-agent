import XCTest
@testable import ReinKlaud

final class ConnectionValidatorTests: XCTestCase {
    private let token = String(repeating: "a", count: 32)

    func testAllowsHTTPSAndPrivateHTTP() throws {
        XCTAssertEqual(try ConnectionValidator.validate(url: "https://rein.example.test", token: token).baseURL.absoluteString, "https://rein.example.test")
        for host in ["10.4.3.2", "192.168.1.4", "172.19.2.8", "100.80.1.2", "rein.local"] {
            XCTAssertNoThrow(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
    }

    func testRejectsPublicHTTPAndURLCredentials() {
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://example.com:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://fda.gov:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://feature.example:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://fe8.example:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://host.netbird.cloud:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://host.tailnet.ts.net:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://rein.lan:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://rein.home.arpa:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://rein-host:4318", token: token))
        XCTAssertNoThrow(try ConnectionValidator.validate(url: "https://host.netbird.cloud", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "https://user@example.com", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "https://example.com/path", token: token))
    }

    func testRejectsMalformedAndMixedLabelIPv4Lookalikes() {
        for host in ["10.alpha.0.1.2", "10.0.0.1.example", "10..0.1.2", "010.0.0.1", "10.0.0.999"] {
            XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
    }

    func testAllowsPrivateIPv4AndIPv6Literals() {
        for host in ["10.4.3.2", "127.0.0.1", "192.168.1.4", "172.31.2.8", "169.254.4.2", "100.64.1.2"] {
            XCTAssertNoThrow(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
        for host in ["[::1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[::ffff:10.0.0.1]"] {
            XCTAssertNoThrow(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
    }

    func testAllowsSafeScopeOnlyOnLinkLocalIPv6() throws {
        XCTAssertEqual(
            try ConnectionValidator.validate(url: "http://[fe80::1%25en0]:4318", token: token).baseURL.absoluteString,
            "http://[fe80::1%25en0]:4318"
        )
        XCTAssertNoThrow(try ConnectionValidator.validate(url: "http://[febf::1%25bridge_0.1]:4318", token: token))

        for host in ["[fd12::1%25en0]", "[::1%25lo0]", "[2001:db8::1%25en0]"] {
            XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
    }

    func testRejectsMalformedIPv6Scopes() {
        for host in ["[fe80::1%25]", "[fe80::1%25en%250]", "[fe80::1%25en%200]", "[fe80::1%25en%2F0]", "[fe80::1%25en:0]"] {
            XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "https://[fd12::1%25en0]:4318", token: token))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "https://[fe80::1%25]:4318", token: token))
    }

    func testCanonicalizesDefaultPortsAndPreservesOtherPorts() throws {
        XCTAssertEqual(try ConnectionValidator.validate(url: "https://rein.example:443", token: token).baseURL.absoluteString, "https://rein.example")
        XCTAssertEqual(try ConnectionValidator.validate(url: "http://localhost:80", token: token).baseURL.absoluteString, "http://localhost")
        XCTAssertEqual(try ConnectionValidator.validate(url: "https://rein.example:8443", token: token).baseURL.absoluteString, "https://rein.example:8443")
        XCTAssertEqual(try ConnectionValidator.validate(url: "http://192.168.1.4:4318", token: token).baseURL.absoluteString, "http://192.168.1.4:4318")
    }

    func testRejectsPublicIPv4AndIPv6Literals() {
        for host in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "[2001:4860:4860::8888]", "[fec0::1]"] {
            XCTAssertThrowsError(try ConnectionValidator.validate(url: "http://\(host):4318", token: token), host)
        }
    }

    func testRequiresServerLengthPrintableToken() {
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "https://rein.example", token: "short"))
        XCTAssertThrowsError(try ConnectionValidator.validate(url: "https://rein.example", token: String(repeating: "x", count: 24) + " "))
    }
}
