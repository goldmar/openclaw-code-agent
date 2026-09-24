import { Array, Boolean, Literal, Number, Object, Optional, String, Union } from "typebox/type";

export type { TLiteral } from "typebox/type";

/**
 * TypeBox builders used for tool parameter schemas.
 *
 * The `typebox` root `Type` object drags the whole TypeBox type system
 * (including the template-literal script parser, ~77 KB minified) into the
 * bundle. Collecting only the builders the tools use keeps TypeBox at ~10 KB.
 * The schemas are plain TypeBox output, the same JSON Schema the OpenClaw
 * plugin SDK types tool parameters with.
 */
export const Type = { Array, Boolean, Literal, Number, Object, Optional, String, Union };
