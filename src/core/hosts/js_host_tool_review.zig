//! Unbound fork: the browser terminal's pre-tool hook. The page's
//! `reviewToolCall` (sdk/fx-sdk.js) sees each tool call before fx's own
//! permission step and answers allow, ask or deny. The SDK validates the
//! answer and fails open, so anything unreadable here is an allow as well.
const std = @import("std");
const tool_admission = @import("../tooling/tool_admission.zig");
const types = @import("../shared/types.zig");

const Allocator = std.mem.Allocator;

/// The SDK bounds reason, context and summary so a review always fits.
const max_review_bytes: usize = 128 * 1024;
const status_cancelled: i32 = -3;

extern "fx" fn fx_tool_review_available() i32;
extern "fx" fn fx_tool_review(
    name_ptr: [*]const u8,
    name_len: usize,
    input_ptr: [*]const u8,
    input_len: usize,
    has_command: u32,
    command_ptr: [*]const u8,
    command_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) i32;

/// Null when the page supplied no hook, so fx admits calls as it always has.
pub fn reviewer() ?tool_admission.HostToolReviewer {
    if (fx_tool_review_available() != 1) return null;
    return .{ .review_fn = review };
}

fn review(
    _: ?*anyopaque,
    arena: Allocator,
    call: types.ToolCall,
    command: ?[]const u8,
) !tool_admission.HostToolReview {
    const buffer = try arena.alloc(u8, max_review_bytes);
    const command_bytes = command orelse "";
    const status = fx_tool_review(
        call.name.ptr,
        call.name.len,
        call.arguments_json.ptr,
        call.arguments_json.len,
        @intFromBool(command != null),
        command_bytes.ptr,
        command_bytes.len,
        buffer.ptr,
        buffer.len,
    );
    if (status == status_cancelled) return .cancelled;
    if (status < 0) return .allow;
    const len: usize = @intCast(status);
    if (len > buffer.len) return .allow;
    return parseReview(arena, buffer[0..len]);
}

fn parseReview(arena: Allocator, bytes: []const u8) tool_admission.HostToolReview {
    const Wire = struct {
        decision: []const u8,
        reason: []const u8 = "",
        context: ?[]const u8 = null,
        summary: ?[]const u8 = null,
    };
    const wire = std.json.parseFromSliceLeaky(Wire, arena, bytes, .{
        .ignore_unknown_fields = true,
    }) catch return .allow;
    const note: tool_admission.HostToolReviewNote = .{
        .reason = wire.reason,
        .context = wire.context,
        .summary = wire.summary,
    };
    if (std.mem.eql(u8, wire.decision, "ask")) return .{ .ask = note };
    if (std.mem.eql(u8, wire.decision, "deny")) return .{ .deny = note };
    return .allow;
}

test "a host review parses into a verdict and anything else allows" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const denied = parseReview(arena, "{\"decision\":\"deny\",\"reason\":\"no pushes\",\"context\":\"org rule 7\"}");
    try std.testing.expectEqualStrings("no pushes", denied.deny.reason);
    try std.testing.expectEqualStrings("org rule 7", denied.deny.context.?);

    const asked = parseReview(arena, "{\"decision\":\"ask\",\"reason\":\"prod data\"}");
    try std.testing.expectEqualStrings("prod data", asked.ask.reason);
    try std.testing.expect(asked.ask.context == null);
    try std.testing.expect(asked.ask.summary == null);

    const summarized = parseReview(arena, "{\"decision\":\"deny\",\"reason\":\"line one\\nline two\",\"summary\":\"Reads a key\"}");
    try std.testing.expectEqualStrings("line one\nline two", summarized.deny.reason);
    try std.testing.expectEqualStrings("Reads a key", summarized.deny.summary.?);

    try std.testing.expect(parseReview(arena, "{\"decision\":\"allow\"}") == .allow);
    try std.testing.expect(parseReview(arena, "{\"decision\":\"maybe\"}") == .allow);
    try std.testing.expect(parseReview(arena, "not json") == .allow);
}
