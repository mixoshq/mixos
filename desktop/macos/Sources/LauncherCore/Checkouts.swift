// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// One instance's owner, from `~/.mixos/instances.json` — the file
/// scripts/instance-claims.ts keeps. Every checkout that has booted MixOS is in
/// it, which is how the launcher finds them without being told.
public struct Claim: Decodable, Equatable, Sendable {
  public let checkout: String
  public let portBase: Int
  public let inspectorPort: Int
}

public enum Claims {
  /// Where scripts/instance-claims.ts keeps them: `MIXOS_STATE_DIR`, else `~/.mixos`.
  public static func fileURL(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
    if let dir = environment["MIXOS_STATE_DIR"], !dir.isEmpty {
      return URL(fileURLWithPath: dir).appendingPathComponent("instances.json")
    }
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".mixos")
      .appendingPathComponent("instances.json")
  }

  /// Every claim, by instance name. Missing or unreadable is none, never an error.
  public static func read(from url: URL = fileURL()) -> [String: Claim] {
    struct File: Decodable { let instances: [String: Claim] }
    guard let data = try? Data(contentsOf: url),
      let file = try? JSONDecoder().decode(File.self, from: data)
    else { return [:] }
    return file.instances
  }
}

public enum CheckoutFolder {
  /// Whether a folder is a MixOS checkout, by what it contains, as
  /// scripts/instance-claims.ts decides it: people clone into any name.
  public static func isMixOS(_ url: URL, fileManager: FileManager = .default) -> Bool {
    fileManager.fileExists(atPath: url.appendingPathComponent("scripts/instance.ts").path)
      && fileManager.fileExists(atPath: url.appendingPathComponent("docker-compose.yml").path)
  }

  /// A folder for a new copy that doesn't exist yet: `MixOS`, as the install
  /// guide uses, then `MixOS-2`, `MixOS-3`, …
  public static func suggestedNew(in parent: URL, fileManager: FileManager = .default) -> URL {
    let first = parent.appendingPathComponent("MixOS")
    if !fileManager.fileExists(atPath: first.path) { return first }
    var n = 2
    while fileManager.fileExists(atPath: parent.appendingPathComponent("MixOS-\(n)").path) { n += 1 }
    return parent.appendingPathComponent("MixOS-\(n)")
  }
}

public enum BootOutput {
  /// The free port a failed boot recommends. When another MixOS holds the app
  /// port, docker-up.ts stops with the command that uses the next free one —
  /// `MIXOS_PORT=3001 npm run dev:docker -- --detach` — because nobody is at a
  /// terminal to answer its question. The launcher turns that into a button.
  public static func recommendedPort(in output: String) -> Int? {
    let pattern = #"MIXOS_PORT=(\d+) npm run (?:dev:docker|docker:prod)"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.matches(in: output, range: NSRange(output.startIndex..., in: output)).last,
      let range = Range(match.range(at: 1), in: output)
    else { return nil }
    return Int(output[range])
  }
}

public enum Versions {
  /// The major version in `v24.3.0`, `24.3.0` or `git version 2.50.1`.
  public static func major(of text: String) -> Int? {
    guard let regex = try? NSRegularExpression(pattern: #"(\d+)\.\d+"#),
      let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
      let range = Range(match.range(at: 1), in: text)
    else { return nil }
    return Int(text[range])
  }
}
