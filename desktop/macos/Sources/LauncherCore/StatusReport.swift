// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// What `npm run status -- --json` says about one checkout: scripts/status.ts
/// writes it, and this is its reader. The checkout answers for itself, so the
/// launcher never has to know how MixOS decides it is up — only how to show it.
///
/// The script only ever adds fields, so unknown ones are ignored here and an
/// older launcher keeps reading a newer checkout.
public struct StatusReport: Decodable, Equatable, Sendable {
  public let version: Int
  public let checkout: String
  public let instance: String
  /// The folder that owns this checkout's instance name, when it isn't this one.
  public let sharedWith: String?
  public let up: Bool
  public let headline: String
  public let app: App?
  public let checks: [Check]
  public let signIn: SignIn?
  public let studioUrl: String?
  public let others: [Other]

  public struct App: Decodable, Equatable, Sendable {
    public let url: String
    public let how: String
    public let docker: Bool
  }

  public enum State: String, Decodable, Sendable {
    case ok, fail, skip
  }

  public struct Check: Decodable, Equatable, Sendable, Identifiable {
    public let state: State
    public let name: String
    public let lines: [String]
    public let fix: String?
    public var id: String { name }
  }

  public struct SignIn: Decodable, Equatable, Sendable {
    public let email: String
    public let password: String
  }

  public struct Other: Decodable, Equatable, Sendable {
    public let instance: String
    public let url: String
    public let how: String
    public let checkout: String?
  }

  /// The report in a command's stdout. Tolerant of anything printed before the
  /// JSON — an npm notice, a Node warning that went to stdout — because the
  /// object itself is the contract, not the stream around it.
  public static func parse(_ output: String) -> StatusReport? {
    guard let start = output.firstIndex(of: "{"), let end = output.lastIndex(of: "}") else { return nil }
    let data = Data(output[start...end].utf8)
    return try? JSONDecoder().decode(StatusReport.self, from: data)
  }
}
