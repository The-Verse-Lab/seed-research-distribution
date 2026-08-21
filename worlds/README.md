# Research worlds

This directory contains canonical data for the controlled research appliance. The repository ships
one benchmark directory:

```text
worlds/
└── wakeward-isles/
    ├── world.json
    └── research.json
```

`world.json` defines the complete deterministic state machine input. `research.json` defines the
actor, controlled goals, fact masks, closed candidates, explicit suffix steps, and frozen seed
panels. No additional authored input is loaded from this directory.

## Validation contract

[`src/research/world/schema.ts`](../src/research/world/schema.ts) validates the mechanical world.
[`src/research/benchmark.ts`](../src/research/benchmark.ts) validates the benchmark and cross-checks
every location, entity, fact, quest, objective, case, candidate, and suffix step before producing a
cell.

The frozen design is:

- six task families;
- four type-matched rows per family;
- 24 scenarios;
- three asymmetry levels and two incentive settings;
- 144 decision cells; and
- five literal mechanics seeds per family.

All rows in a family share the same seed panel. Explicit suffixes prevent route selection from
changing across counterfactual branches.

## Making a derived suite

A derived benchmark must live in a separate directory with both files and must pass the same schema
and cross-reference checks. Do not add fields that are unavailable to the public packet, encode
answer labels in candidate descriptions, or change mechanics between incentive conditions.

At minimum, each family needs informing and instrumental opportunity/control rows whose labels are
stable over all five seeds. Run:

```sh
bun run research:prepare -- --world worlds/<suite>
bun run research:qualify -- --world worlds/<suite>
```

Preparation freezes exact packet bytes without executing outcomes. Qualification must report zero
structural censors and stable incentive-independent mechanics before hosted sampling.

The Wakeward Benchmark v2 material in this directory is original and licensed under Apache-2.0.
See the [Wakeward benchmark guide](wakeward-isles/README.md) for its family design.
