export type JsonSchema = Record<string, unknown>;
export type TLiteral<T extends string | number | boolean> = JsonSchema & { const: T };

const optionalSchema = Symbol("optionalSchema");

type OptionalSchema = JsonSchema & { [optionalSchema]?: true };

function withOptions(schema: JsonSchema, options?: JsonSchema): JsonSchema {
  return options ? { ...options, ...schema } : schema;
}

function optional(schema: JsonSchema): OptionalSchema {
  return { ...schema, [optionalSchema]: true };
}

function literal<T extends string | number | boolean>(value: T): TLiteral<T> {
  return { const: value, type: typeof value } as TLiteral<T>;
}

export const Type = {
  Object(properties: Record<string, JsonSchema>, options?: JsonSchema): JsonSchema {
    const required = Object.entries(properties)
      .filter(([, schema]) => !(schema as OptionalSchema)[optionalSchema])
      .map(([name]) => name);
    const cleanProperties = Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => {
        const { [optionalSchema]: _optional, ...cleanSchema } = schema as OptionalSchema;
        return [name, cleanSchema];
      }),
    );

    return {
      ...options,
      type: "object",
      ...(required.length > 0 ? { required } : {}),
      properties: cleanProperties,
    };
  },
  String(options?: JsonSchema): JsonSchema {
    return withOptions({ type: "string" }, options);
  },
  Number(options?: JsonSchema): JsonSchema {
    return withOptions({ type: "number" }, options);
  },
  Boolean(options?: JsonSchema): JsonSchema {
    return withOptions({ type: "boolean" }, options);
  },
  Array(items: JsonSchema, options?: JsonSchema): JsonSchema {
    return withOptions({ type: "array", items }, options);
  },
  Literal: literal,
  Union(anyOf: JsonSchema[], options?: JsonSchema): JsonSchema {
    return withOptions({ anyOf }, options);
  },
  Optional: optional,
};
