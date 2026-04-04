# HiveMQ Edge Configuration Repository

This is a **template** for managing HiveMQ Edge configuration as code (GitOps-style).

## How to use this template

1. Click **Use this template** on GitHub to create your own repo.
2. Rename `instances/my-site/` to your actual site name (must match the Edge instance ID).
3. Edit or replace the adapter stubs under `instances/<site>/adapters/`.
4. Push — GitHub Actions will compile and validate automatically.

## Repository structure

```
├── edge-project.yaml              # Project descriptor (rarely needs editing)
├── build.gradle.kts               # Gradle build — preprocess + compile tasks
├── scripts/preprocess.ts          # Deno preprocessor ($include / $vars)
├── compiler/
│   └── hivemq-edge-compiler.jar  # Compiler binary (bundled until published to Maven)
├── fleet/                         # Shared YAML templates (optional)
│   └── northbound-mapping.yaml   # Default northbound mapping options
└── instances/
    └── my-site/                  # One directory per Edge instance
        └── adapters/
            └── my-adapter/
                ├── adapter.yaml       # Adapter type, connection settings
                └── example-tag.yaml   # Tag definitions and northbound mappings
```

## Local compilation

Requirements: Java 21, [Deno v2](https://deno.land/), and `./gradlew`.

```sh
./gradlew compile
```

Compiled configs are written to `build/preprocessed/build/<instance>/compiled-config.json`.

## Fleet templates and `$include`

Put reusable YAML fragments in `fleet/`. Reference them in instance files with `$include`:

```yaml
northbound:
  - $include: fleet/northbound-mapping.yaml
    tag:
      name: MyTag
    topic: site/adapter/my-tag
```

Use `$vars` for parameterised templates:

```yaml
mappings:
  - $include: fleet/data-combiners/my-template.yaml
    $vars:
      nr: "01"
      sensor: Temperature
```

## CI/CD

GitHub Actions runs on every push:

1. Checkout → Java 21 → Deno
2. `./gradlew compile` (preprocess + compile all instances)
3. Upload `compiled-config.json` files as build artifacts (retained 90 days)

Download the artifact and publish it to your Edge instance via MQTT:

```sh
mqtt pub -h <edge-host> -p 1883 -q 1 \
  -t 'HIVEMQ/-/EDGE/-/CONFIGURATION/apply' \
  -m:file=compiled-config.json
```
