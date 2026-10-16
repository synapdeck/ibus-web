// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { type Schema, SchemaAST } from "effect";
import { parseType, CodecError } from "../gvariant/type.ts";
import { type GVariantValue } from "../gvariant/value.ts";
import { gvariantTypeOf } from "./annotations.ts";

interface Plan {
  readonly signature: string;
  readonly toTree: (encoded: unknown) => GVariantValue;
  readonly fromTree: (tree: GVariantValue) => unknown;
}

const rootPlans = new WeakMap<SchemaAST.AST, Plan>();
const memberPlans = new WeakMap<SchemaAST.AST, Plan>();

function fail(message: string): never {
  throw new CodecError({ message });
}

function expectNode<Tag extends GVariantValue["_tag"]>(
  tree: GVariantValue,
  tag: Tag,
): GVariantValue & { readonly _tag: Tag } {
  if (tree._tag !== tag) fail(`Expected GVariant ${tag}, received ${tree._tag}`);
  return tree as GVariantValue & { readonly _tag: Tag };
}

const variantPlan: Plan = {
  signature: "v",
  toTree: (encoded) => expectNode(encoded as GVariantValue, "v"),
  fromTree: (tree) => expectNode(tree, "v"),
};

function dictionaryPlan(valuePlan: Plan): Plan {
  return {
    signature: `a{s${valuePlan.signature}}`,
    toTree: (encoded) => ({
      _tag: "a",
      items: Object.entries(encoded as Record<string, unknown>).map(([key, value]) => ({
        _tag: "{}",
        key: { _tag: "s", value: key },
        value: valuePlan.toTree(value),
      })),
    }),
    fromTree(tree) {
      const entries = expectNode(tree, "a").items.map((item) => {
        const entry = expectNode(item, "{}");
        return [expectNode(entry.key, "s").value, valuePlan.fromTree(entry.value)];
      });
      return Object.fromEntries(entries);
    },
  };
}

function compile(ast: SchemaAST.AST, member = false, field = "value"): Plan {
  const cache = member ? memberPlans : rootPlans;
  const cached = cache.get(ast);
  if (cached) return cached;
  if (ast._tag === "Suspend") return compile(ast.thunk(), member, field);

  let plan: Plan;
  const ibusType = ast.annotations?.ibusType;
  if (ast._tag === "Objects" && ibusType && member) {
    // Resolved on first use: a recursive serializable reaches its own member plan while its root
    // plan is still being built.
    let inner: Plan | undefined;
    plan = {
      signature: "v",
      toTree(encoded) {
        inner ??= compile(ast);
        return { _tag: "v", type: inner.signature, value: inner.toTree(encoded) };
      },
      fromTree(tree) {
        const variant = expectNode(tree, "v");
        inner ??= compile(ast);
        if (variant.type !== inner.signature) fail(`Expected ${ibusType} variant type ${inner.signature}`);
        return inner.fromTree(variant.value);
      },
    };
  } else if (ast._tag === "Declaration" && ast.typeParameters[0]?._tag === "Objects") {
    plan = objectPlan(ast.typeParameters[0]);
  } else if (ast._tag === "Arrays" && ast.elements.length === 0 && ast.rest.length === 1) {
    const element = compile(ast.rest[0]!, true, `${field}[]`);
    plan = {
      signature: `a${element.signature}`,
      toTree: (encoded) => ({ _tag: "a", items: (encoded as readonly unknown[]).map(element.toTree) }),
      fromTree: (tree) => expectNode(tree, "a").items.map(element.fromTree),
    };
  } else if (ast._tag === "Objects") {
    plan = objectPlan(ast, ibusType);
  } else {
    const signature = gvariantTypeOf(ast);
    if (!signature) fail(`Field ${field} has no GVariant type annotation`);
    parseType(signature);
    if (signature === "a{sv}") {
      plan = dictionaryPlan(variantPlan);
    } else if (signature === "v") {
      plan = variantPlan;
    } else if (/^[bynqiuhdxtsog]$/.test(signature)) {
      plan = {
        signature,
        toTree: (encoded) => ({ _tag: signature, value: encoded }) as GVariantValue,
        fromTree(tree) {
          if (tree._tag !== signature || !("value" in tree)) fail(`Field ${field} expected GVariant ${signature}`);
          return tree.value;
        },
      };
    } else {
      fail(`Field ${field} has unsupported GVariant annotation ${signature}`);
    }
  }
  cache.set(ast, plan);
  return plan;
}

function attachmentPlan(plan: Plan): Plan {
  return {
    signature: plan.signature,
    toTree(encoded) {
      const dictionary = expectNode(plan.toTree(encoded), "a");
      return {
        _tag: "a",
        items: dictionary.items.map((item) => {
          const entry = expectNode(item, "{}");
          return { ...entry, value: { _tag: "v", type: "v", value: entry.value } };
        }),
      };
    },
    fromTree(tree) {
      const dictionary = expectNode(tree, "a");
      const items = dictionary.items.map((item) => {
        const entry = expectNode(item, "{}");
        const wrapper = expectNode(entry.value, "v");
        if (wrapper.type !== "v") fail("IBus attachments require an inner variant");
        return { ...entry, value: expectNode(wrapper.value, "v") };
      });
      return plan.fromTree({ _tag: "a", items });
    },
  };
}

function objectPlan(ast: SchemaAST.Objects, ibusType?: string): Plan {
  if (ast.indexSignatures.length === 1 && ast.propertySignatures.length === 0) {
    const index = ast.indexSignatures[0]!;
    if (index.parameter._tag !== "String") fail("GVariant dictionaries require string keys");
    return dictionaryPlan(compile(index.type, true, "dictionary value"));
  }
  if (ast.indexSignatures.length !== 0) fail("Unsupported GVariant object index signatures");
  const tag = ast.propertySignatures.find((property) => property.name === "_tag");
  const fields = ast.propertySignatures
    .filter((property) => property.name !== "_tag")
    .map((property) => {
      if (SchemaAST.isOptional(property.type)) {
        fail(`Field ${String(property.name)} is optional, but GVariant tuples have no optional members`);
      }
      const plan = compile(property.type, true, String(property.name));
      return {
        name: property.name,
        // IBus wraps an attachment once more inside the dictionary's variant slot.
        plan: ibusType && property.name === "attachments" ? attachmentPlan(plan) : plan,
      };
    });
  const prefix = ibusType ? "s" : "";
  return {
    signature: `(${prefix}${fields.map((field) => field.plan.signature).join("")})`,
    toTree(encoded) {
      const values = encoded as Record<PropertyKey, unknown>;
      const items = fields.map((field) => field.plan.toTree(values[field.name]));
      if (ibusType) items.unshift({ _tag: "s", value: ibusType });
      return { _tag: "()", items };
    },
    fromTree(tree) {
      const items = expectNode(tree, "()").items;
      const offset = ibusType ? 1 : 0;
      if (items.length !== fields.length + offset) fail("Wrong number of GVariant tuple fields");
      if (ibusType && expectNode(items[0]!, "s").value !== ibusType) fail(`Expected serializable name ${ibusType}`);
      const entries = fields.map((field, index) => [field.name, field.plan.fromTree(items[index + offset]!)]);
      if (tag?.type._tag === "Literal") entries.unshift(["_tag", tag.type.literal]);
      return Object.fromEntries(entries);
    },
  };
}

export function signatureOf(schema: Schema.Top): string {
  return compile(schema.ast).signature;
}

export function toTree<S extends Schema.Top>(schema: S): (encoded: S["Encoded"]) => GVariantValue {
  return compile(schema.ast).toTree;
}

export function fromTree<S extends Schema.Top>(schema: S): (tree: GVariantValue) => S["Encoded"] {
  return compile(schema.ast).fromTree as (tree: GVariantValue) => S["Encoded"];
}
