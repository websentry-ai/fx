//! Unbound fork addition: host tools for the browser terminal.
//!
//! The ACP browser build already takes host tools (`createFxAgent({ tools })`)
//! and runs them through `js_host_tools`. The terminal build had no way to
//! receive their descriptors. This loads them from the host at boot and
//! merges them after the browser workspace tools, so they are advertised and
//! dispatched through the same registry.
//!
//! The browser has no MCP runtime of fx's own, so the host runs MCP servers and
//! exposes their tools as host tools. `/mcp` goes to the host too, and a server
//! added mid-session changes the tools: `stale` reports that, and the app loads
//! the new set before its next prompt.

const std = @import("std");
const host_tool_runtime = @import("../tooling/host_tool_runtime.zig");
const js_host_tools = @import("js_host_tools.zig");
const tool_dispatch = @import("../tooling/tool_dispatch.zig");
const tool_set = @import("../tooling/tool_set.zig");

const Allocator = std.mem.Allocator;
const max_descriptor_bytes: usize = 1024 * 1024;
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

    /// Reads the host's descriptors and appends them to `base`. A host that
    /// supplies none, or supplies an invalid set, leaves the terminal as it was.
    pub fn load(alloc: Allocator, base: tool_set.ToolSet) TermHostTools {
        const generation = fx_host_tools_generation();
        var loaded = loadInner(alloc, base) catch TermHostTools{};
        loaded.generation = generation;
        return loaded;
    }

    /// Whether the host replaced its tools after these were loaded. The host
    /// answers once any replacement it is still preparing has settled.
    pub fn stale(self: *const TermHostTools) bool {
        return fx_host_tools_generation() != self.generation;
    }

    fn loadInner(alloc: Allocator, base: tool_set.ToolSet) !TermHostTools {
        const buffer = try alloc.alloc(u8, max_descriptor_bytes);
        defer alloc.free(buffer);
        const len = fx_host_tools_descriptors(buffer.ptr, buffer.len);
        if (len <= 0) return .{};

        const parsed = try std.json.parseFromSlice(std.json.Value, alloc, buffer[0..@intCast(len)], .{});
        defer parsed.deinit();
        var runtime = try host_tool_runtime.Runtime.init(alloc, parsed.value);
        errdefer runtime.deinit();
        if (runtime.tools.len == 0) return .{};

        const tools = try std.mem.concat(alloc, tool_dispatch.Tool, &.{ base.registry.tools, runtime.tools });
        errdefer alloc.free(tools);
        // A host tool has no argument to show, so the transcript names the tool:
        // "Called mcp__memory__read_graph" rather than a bare "Ran".
        for (tools[base.registry.tools.len..]) |*tool| {
            tool.action_label = "Calling";
            tool.completed_action_label = "Called";
            tool.label_arg_default = tool.name;
        }
        const order = try std.mem.concat(alloc, []const u8, &.{ base.order, runtime.order });
        return .{ .backing = alloc, .runtime = runtime, .tools = tools, .order = order };
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

    /// Runs `/mcp <rest>` in the host and returns what it printed, or null
    /// when the host does not take MCP commands.
    pub fn mcpCommand(alloc: Allocator, rest: []const u8) !?[]u8 {
        const buffer = try alloc.alloc(u8, max_command_output_bytes);
        defer alloc.free(buffer);
        const len = fx_host_mcp_command(rest.ptr, rest.len, buffer.ptr, buffer.len);
        if (len < 0) return null;
        return try alloc.dupe(u8, buffer[0..@intCast(len)]);
    }

    pub fn deinit(self: *TermHostTools) void {
        const alloc = self.backing orelse return;
        alloc.free(self.tools);
        alloc.free(self.order);
        self.runtime.deinit();
        self.* = .{};
    }
};
