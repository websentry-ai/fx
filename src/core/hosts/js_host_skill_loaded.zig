//! Unbound fork addition: tell the browser host when the skill tool loaded a skill.
//!
//! A host that enforces a policy of "load this skill first" needs to know that
//! the agent really loaded it. Reading the file is not that signal: discovery
//! opens every SKILL.md at startup and on every refresh. This fires only when
//! the `skill` tool returns a skill to the model.

const std = @import("std");
const host_target = @import("target.zig");

extern "fx" fn fx_host_skill_loaded(ptr: [*]const u8, len: usize) void;

pub fn notify(name: []const u8) void {
    if (comptime !host_target.is_wasm) return;
    if (name.len == 0) return;
    fx_host_skill_loaded(name.ptr, name.len);
}
