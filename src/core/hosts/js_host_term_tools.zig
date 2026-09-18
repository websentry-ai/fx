const std = @import("std");
const host_tool_runtime = @import("../tooling/host_tool_runtime.zig");
const js_host_tools = @import("js_host_tools.zig");
const tool_dispatch = @import("../tooling/tool_dispatch.zig");
const tool_set = @import("../tooling/tool_set.zig");

const Allocator = std.mem.Allocator;
const max_descriptor_bytes: usize = host_tool_runtime.max_tools *
    (host_tool_runtime.max_name_bytes +
        host_tool_runtime.max_description_bytes +
        host_tool_runtime.max_schema_bytes +
        128);
const max_command_output_bytes: usize = 64 * 1024;

extern "fx" fn fx_host_tools_descriptors(ptr: [*]u8, cap: usize) i32;
extern "fx" fn fx_host_tools_generation() i32;
extern "fx" fn fx_host_mcp_command(ptr: [*]const u8, len: usize, out: [*]u8, cap: usize) i32;

pub const TermHostTools = struct {
    backing: ?Allocator = null,
    runtime: host_tool_runtime.Runtime = .{},
    tools: []tool_dispatch.Tool = &.{},
    order: [][]const u8 = &.{},
    generation: i32 = 0,

    pub fn load(alloc: Allocator, base: tool_set.ToolSet) !TermHostTools {
        const generation = fx_host_tools_generation();
        if (generation < 0) return error.HostToolUpdateFailed;
        var loaded = try loadInner(alloc, base);
        loaded.generation = generation;
        return loaded;
    }

    pub fn stale(self: *const TermHostTools) !bool {
        const generation = fx_host_tools_generation();
        if (generation < 0) return error.HostToolUpdateFailed;
        return generation != self.generation;
    }

    fn loadInner(alloc: Allocator, base: tool_set.ToolSet) !TermHostTools {
        var probe: [1]u8 = undefined;
        const required = fx_host_tools_descriptors(&probe, 0);
        if (required < 0) return error.InvalidHostToolDescriptors;
        if (required == 0) return .{};
        const required_len: usize = @intCast(required);
        if (required_len > max_descriptor_bytes) return error.HostToolDescriptorsTooLarge;

        const buffer = try alloc.alloc(u8, required_len);
        defer alloc.free(buffer);
        const raw_len = fx_host_tools_descriptors(buffer.ptr, buffer.len);
        if (raw_len == -2) return error.HostToolDescriptorsTooLarge;
        if (raw_len < 0) return error.InvalidHostToolDescriptors;
        if (raw_len == 0) return .{};
        const len: usize = @intCast(raw_len);
        if (len > buffer.len) return error.InvalidHostToolDescriptors;

        const parsed = std.json.parseFromSlice(std.json.Value, alloc, buffer[0..len], .{}) catch
            return error.InvalidHostToolDescriptors;
        defer parsed.deinit();
        var runtime = try host_tool_runtime.Runtime.init(alloc, parsed.value);
        errdefer runtime.deinit();
        if (runtime.tools.len == 0) return .{};
        for (runtime.order) |name| {
            if (base.registry.lookup(name) != null) return error.DuplicateHostToolName;
        }

        const tools = try std.mem.concat(alloc, tool_dispatch.Tool, &.{ base.registry.tools, runtime.tools });
        errdefer alloc.free(tools);
        for (tools[base.registry.tools.len..]) |*tool| applyHostToolPresentation(tool);
        const order = try std.mem.concat(alloc, []const u8, &.{ base.order, runtime.order });
        return .{
            .backing = alloc,
            .runtime = runtime,
            .tools = tools,
            .order = order,
        };
    }

    pub fn toolSet(self: *const TermHostTools) ?tool_set.ToolSet {
        if (self.tools.len == 0) return null;
        return .{
            .registry = .{ .tools = self.tools },
            .order = self.order,
            .read_only_tool_names = &.{},
        };
    }

    pub fn provider(self: *const TermHostTools) ?tool_dispatch.HostToolProvider {
        if (self.tools.len == 0) return null;
        return js_host_tools.provider();
    }

    pub fn mcpCommand(alloc: Allocator, rest: []const u8) !?[]u8 {
        const buffer = try alloc.alloc(u8, max_command_output_bytes);
        defer alloc.free(buffer);
        const raw_len = fx_host_mcp_command(rest.ptr, rest.len, buffer.ptr, buffer.len);
        if (raw_len == -1) return null;
        if (raw_len == -2) return error.HostMcpResponseTooLarge;
        if (raw_len < 0) return error.HostMcpCommandFailed;
        const len: usize = @intCast(raw_len);
        if (len > buffer.len) return error.HostMcpCommandFailed;
        return try alloc.dupe(u8, buffer[0..len]);
    }

    pub fn deinit(self: *TermHostTools) void {
        const alloc = self.backing orelse return;
        alloc.free(self.tools);
        alloc.free(self.order);
        self.runtime.deinit();
        self.* = .{};
    }
};

fn applyHostToolPresentation(tool: *tool_dispatch.Tool) void {
    if (std.mem.eql(u8, tool.name, "skill")) {
        tool.activity_kind = .read;
        tool.action_label = "Loading skill";
        tool.completed_action_label = "Loaded skill";
        tool.label_arg_kind = .name;
        tool.label_arg_default = "skill";
        return;
    }

    tool.action_label = "Calling";
    tool.completed_action_label = "Called";
    tool.label_arg_default = tool.name;
}

test "skill host tool keeps skill presentation" {
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        alloc,
        \\[{"name":"skill","description":"Load a skill","inputSchema":{}},{"name":"mcp__memory__read_graph","description":"Read memory","inputSchema":{}}]
    ,
        .{},
    );
    defer parsed.deinit();

    var runtime = try host_tool_runtime.Runtime.init(alloc, parsed.value);
    defer runtime.deinit();
    const tools = try alloc.dupe(tool_dispatch.Tool, runtime.tools);
    defer alloc.free(tools);
    for (tools) |*tool| applyHostToolPresentation(tool);

    try std.testing.expectEqual(.read, tools[0].activity_kind);
    try std.testing.expectEqualStrings("Loading skill", tools[0].action_label);
    try std.testing.expectEqualStrings("Loaded skill", tools[0].completed_action_label);
    try std.testing.expectEqual(.name, tools[0].label_arg_kind);
    try std.testing.expectEqualStrings("skill", tools[0].label_arg_default);

    try std.testing.expectEqual(.command, tools[1].activity_kind);
    try std.testing.expectEqualStrings("Calling", tools[1].action_label);
    try std.testing.expectEqualStrings("Called", tools[1].completed_action_label);
    try std.testing.expectEqual(.none, tools[1].label_arg_kind);
    try std.testing.expectEqualStrings("mcp__memory__read_graph", tools[1].label_arg_default);
}
