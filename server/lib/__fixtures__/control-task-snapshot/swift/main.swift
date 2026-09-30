import Foundation
let data = FileManager.default.contents(atPath: CommandLine.arguments[1])!
let rows = try JSONDecoder().decode([JSONValue].self, from: data)
let dump = CommandLine.arguments.count > 2
for row in rows {
  guard let task = TaskRow(row) else { print("nil"); continue }
  let s = WorkSource.taskSnapshot(task)
  if dump { print(s.context.debugDescription) }
  print(s.id, s.revision)
}
