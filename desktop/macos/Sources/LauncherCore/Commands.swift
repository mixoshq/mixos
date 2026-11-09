// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// The PATH the person's own terminal has.
///
/// An app opened from Finder or the Dock starts with launchd's PATH —
/// `/usr/bin:/bin:/usr/sbin:/sbin` — which has no Homebrew, no nvm and no
/// Docker CLI, so `npm` and `docker` are simply not found. The fix is to ask
/// the person's login shell, interactively, since nvm sets itself up in
/// `~/.zshrc`, and to keep the usual install locations as a fallback for a
/// shell that answers nothing useful.
public enum LoginShell {
  static let marker = "__MIXOS_PATH__"

  /// Where Node, Docker and Homebrew land when nothing else says otherwise.
  static let fallback = [
    "/opt/homebrew/bin", "/usr/local/bin", "/Applications/Docker.app/Contents/Resources/bin",
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ]

  /// The PATH between the markers, ignoring whatever a shell's startup files print.
  public static func parse(_ output: String) -> String? {
    let parts = output.components(separatedBy: marker)
    guard parts.count >= 3 else { return nil }
    let path = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty ? nil : path
  }

  /// `path` with every fallback directory it lacks added at the end, in order, once.
  public static func merged(_ path: String?) -> String {
    var seen = Set<String>()
    var out: [String] = []
    for dir in (path?.split(separator: ":").map(String.init) ?? []) + fallback where !dir.isEmpty {
      if seen.insert(dir).inserted { out.append(dir) }
    }
    return out.joined(separator: ":")
  }

  /// Ask the login shell, within ten seconds: a `.zshrc` that waits on
  /// something must not hang the app. The answer is the fallback without it.
  public static func resolvePath() async -> String {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let runner = CommandRunner(path: merged(nil))
    let result = await runner.run(
      [shell, "-l", "-i", "-c", "printf '\(marker)%s\(marker)' \"$PATH\""],
      timeout: 10,
      direct: true
    )
    return merged(parse(result.output))
  }
}

public struct CommandResult: Sendable {
  public let status: Int32
  public let output: String
  public var succeeded: Bool { status == 0 }
}

/// Runs commands the way the person's terminal would: their PATH, argument
/// arrays and never a shell string, and the environment MixOS's scripts read
/// to know nobody is at a terminal.
public final class CommandRunner: @unchecked Sendable {
  public let path: String

  public init(path: String) {
    self.path = path
  }

  /// The environment for a child. `NO_COLOR` because output lands in a text
  /// view; `MIXOS_OPEN_BROWSER=false` because the launcher opens the browser
  /// itself, once, and only when the person wants it.
  public func environment(_ extra: [String: String] = [:]) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = path
    env["NO_COLOR"] = "1"
    env["MIXOS_OPEN_BROWSER"] = "false"
    for (key, value) in extra { env[key] = value }
    return env
  }

  private func process(_ args: [String], in dir: URL?, env: [String: String], direct: Bool) -> Process {
    let process = Process()
    if direct {
      process.executableURL = URL(fileURLWithPath: args[0])
      process.arguments = Array(args.dropFirst())
    } else {
      // /usr/bin/env finds the command on the PATH given to it, ours.
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = args
    }
    process.environment = env
    if let dir { process.currentDirectoryURL = dir }
    process.standardInput = FileHandle.nullDevice
    return process
  }

  /// Run to the end and collect stdout; stderr is dropped. For questions with
  /// one answer: `npm run status -- --json`, `node --version`.
  public func run(
    _ args: [String],
    in dir: URL? = nil,
    extraEnv: [String: String] = [:],
    timeout: TimeInterval? = nil,
    direct: Bool = false
  ) async -> CommandResult {
    let process = process(args, in: dir, env: environment(extraEnv), direct: direct)
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    return await withCheckedContinuation { continuation in
      let collected = Locked(Data())
      out.fileHandleForReading.readabilityHandler = { handle in
        let chunk = handle.availableData
        if !chunk.isEmpty { collected.mutate { $0.append(chunk) } }
      }
      process.terminationHandler = { finished in
        out.fileHandleForReading.readabilityHandler = nil
        let rest = out.fileHandleForReading.readDataToEndOfFile()
        let data = collected.mutate { $0.append(rest); return $0 }
        continuation.resume(returning: CommandResult(
          status: finished.terminationStatus,
          output: String(decoding: data, as: UTF8.self)
        ))
      }
      do {
        try process.run()
      } catch {
        out.fileHandleForReading.readabilityHandler = nil
        continuation.resume(returning: CommandResult(status: 127, output: ""))
        return
      }
      if let timeout {
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
          if process.isRunning { process.terminate() }
        }
      }
    }
  }

  /// Run with stdout and stderr streamed, line by line, as one log. For the
  /// long jobs a person watches: a first boot, `npm ci`, a clone. `onStart`
  /// hands over the process so it can be cancelled.
  public func stream(
    _ args: [String],
    in dir: URL? = nil,
    extraEnv: [String: String] = [:],
    onStart: @escaping @Sendable (Process) -> Void = { _ in },
    onLine: @escaping @Sendable (String) -> Void
  ) async -> CommandResult {
    let process = process(args, in: dir, env: environment(extraEnv), direct: false)
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    return await withCheckedContinuation { continuation in
      let state = Locked((pending: "", all: ""))
      let emit: @Sendable (String, Bool) -> Void = { text, final in
        let lines: [String] = state.mutate { state in
          state.all += text
          state.pending += text
          var parts = state.pending.components(separatedBy: "\n")
          state.pending = final ? "" : parts.removeLast()
          return parts
        }
        for line in lines {
          let clean = line.replacingOccurrences(of: "\r", with: "")
          if !(final && clean.isEmpty) { onLine(clean) }
        }
      }
      pipe.fileHandleForReading.readabilityHandler = { handle in
        let chunk = handle.availableData
        if !chunk.isEmpty { emit(String(decoding: chunk, as: UTF8.self), false) }
      }
      process.terminationHandler = { finished in
        pipe.fileHandleForReading.readabilityHandler = nil
        emit(String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self), true)
        continuation.resume(returning: CommandResult(
          status: finished.terminationStatus,
          output: state.mutate { $0.all }
        ))
      }
      do {
        try process.run()
        onStart(process)
      } catch {
        pipe.fileHandleForReading.readabilityHandler = nil
        onLine("Could not run \(args.first ?? "the command"): \(error.localizedDescription)")
        continuation.resume(returning: CommandResult(status: 127, output: ""))
      }
    }
  }
}

/// A value shared between a pipe's reader thread and its termination handler.
final class Locked<Value>: @unchecked Sendable {
  private var value: Value
  private let lock = NSLock()

  init(_ value: Value) {
    self.value = value
  }

  @discardableResult
  func mutate<T>(_ body: (inout Value) -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body(&value)
  }
}
