// ─── Compiler JAR ─────────────────────────────────────────────────────────────
// Currently: the compiler JAR is committed to this repo at compiler/hivemq-edge-compiler.jar.
// This is temporary — there is currently no published artifact to download from.
//
// Once hivemq-edge-compiler is published to a Maven repository, replace the
// 'compilerJar' line below with dependency resolution:
//
//   configurations { create("compilerTool") }
//   dependencies {
//       "compilerTool"("com.hivemq:hivemq-edge-compiler:<version>")
//   }
//   val compilerJar: File by lazy { configurations["compilerTool"].singleFile }
//
// The resolved JAR comes from the Gradle dependency cache (~/.gradle/caches/) —
// it does NOT land in build/. On CI, cache ~/.gradle/caches/ between runs.
// Once this is in place, the compiler/ directory can be removed from the repo.

val compilerJar = file("compiler/hivemq-edge-compiler.jar")
val preprocessedDir = layout.buildDirectory.dir("preprocessed").get().asFile

// ─── Discover instances ───────────────────────────────────────────────────────
val instanceDirs: List<String> = file("instances")
    .listFiles()
    ?.filter { it.isDirectory }
    ?.map { it.name }
    ?: emptyList()

// ─── Preprocess task ──────────────────────────────────────────────────────────
// Resolves $include directives and writes concrete YAML to build/preprocessed/.
// Instances that contain no $include directives are copied unchanged.
val preprocess = tasks.register<Exec>("preprocess") {
    group = "build"
    description = "Resolve \$include directives into build/preprocessed/"
    commandLine("deno", "run", "--allow-read", "--allow-write", "scripts/preprocess.ts")
}

// ─── Per-instance compile tasks ───────────────────────────────────────────────
val compileAll = tasks.register("compile") {
    group = "build"
    description = "Compile all instances"
}

instanceDirs.forEach { instance ->
    val task = tasks.register<Exec>("compile-$instance") {
        group = "build"
        description = "Compile instance: $instance"
        dependsOn(preprocess)
        val outputFile = layout.buildDirectory.file("$instance/compiled-config.json").get().asFile
        commandLine(
            "sh", "-c",
            "cd '${preprocessedDir.absolutePath}' && " +
            "java -jar '${compilerJar.absolutePath}' -p . --instance $instance" +
            " --output '${outputFile.absolutePath}'"
        )
    }
    compileAll { dependsOn(task) }
}
