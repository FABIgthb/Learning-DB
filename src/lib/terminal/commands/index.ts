import type { CommandSpec } from "../command";
import { BAT_COMMANDS } from "./bat";
import { FILE_COMMANDS } from "./files";
import { FZF_COMMANDS } from "./fzf";
import { JQ_COMMANDS } from "./jq";
import { RG_COMMANDS } from "./rg";
import { SYSTEM_COMMANDS, registry } from "./system";
import { TEXT_COMMANDS } from "./text";

export const COMMANDS: Record<string, CommandSpec> = Object.fromEntries(
  [...FILE_COMMANDS, ...TEXT_COMMANDS, ...SYSTEM_COMMANDS, ...FZF_COMMANDS, ...JQ_COMMANDS, ...RG_COMMANDS, ...BAT_COMMANDS].map((spec) => [spec.name, spec]),
);

registry.commands = COMMANDS;
