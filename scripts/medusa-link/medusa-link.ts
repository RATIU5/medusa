#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.4/command/mod.ts"
import { walk } from "jsr:@std/fs"
import { join } from "jsr:@std/path"

async function isNodeLib(dir: string): Promise<string | null> {
  try {
    const packageJsonPath = join(dir, "package.json")
    const packageJson = JSON.parse(await Deno.readTextFile(packageJsonPath))
    return packageJson.name?.startsWith("@medusajs") ? packageJson.name : null
  } catch {
    return null
  }
}

async function findNodeProjects(
  rootDir?: string
): Promise<Map<string, string>> {
  if (!rootDir) {
    throw new Error("Root directory is required")
  }
  const projects = new Map<string, string>()
  for await (const entry of walk(rootDir, {
    includeDirs: true,
    includeFiles: false,
    skip: [
      /\.git/,
      /node_modules/,
      /__tests__/,
      /__fixtures__/,
      /oas-github-ci/,
    ],
  })) {
    const projectName = await isNodeLib(entry.path)
    if (projectName) {
      projects.set(projectName, entry.path)
    }
  }
  return projects
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ success: boolean; output: string }> {
  const command = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stdout, stderr } = await command.output()
  const output = new TextDecoder().decode(code === 0 ? stdout : stderr)
  return { success: code === 0, output }
}

async function linkProject(projectName: string, projectDir: string) {
  const buildResult = await runCommand("yarn", ["build"], projectDir)
  if (!buildResult.success) {
    console.error(`Failed to build ${projectName}`)
    console.error(buildResult.output)
    return
  }

  const linkResult = await runCommand("yarn", ["link"], projectDir)
  if (!linkResult.success) {
    console.error(`Failed to link ${projectName}`)
    console.error(linkResult.output)
    return
  }

  console.log(`Successfully linked ${projectName}`)
}

async function watchProjects(projects: Map<string, string>) {
  console.log("Watching projects for changes...")
  const watcher = Deno.watchFs([...projects.values()])
  for await (const event of watcher) {
    if (event.kind === "modify") {
      const modifiedDir = event.paths[0].split("/").slice(0, -1).join("/")
      for (const [projectName, projectDir] of projects.entries()) {
        if (modifiedDir.startsWith(projectDir)) {
          console.log(`Change detected in ${projectName}`)
          await linkProject(projectName, projectDir)
          break
        }
      }
    }
  }
}

await new Command()
  .name("medusa-link")
  .version("1.0.0")
  .description("CLI tool for linking Medusa 2.0 libraries to your project")
  .command(
    "link <directory:string>",
    "Link all Medusajs libraries in the monorepo"
  )
  .action(async (_, directory) => {
    const projects = await findNodeProjects(directory)
    for (const [projectName, projectDir] of projects) {
      await linkProject(projectName, projectDir)
    }
  })
  .command(
    "watch <directory:string>",
    "Watch all projects for changes and relink"
  )
  .action(async (_, directory) => {
    const projects = await findNodeProjects(directory)
    for (const [projectName, projectDir] of projects) {
      // await linkProject(projectName, projectDir)
    }
    await watchProjects(projects)
  })
  .parse(Deno.args)
