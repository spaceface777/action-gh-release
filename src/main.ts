import { paths, parseConfig, isTag, unmatchedPatterns } from "./util";
import { release, upload, Releaser } from "./github";
import { setFailed, setOutput } from "@actions/core";
import { GitHub } from "@actions/github";
import Archiver from "archiver";
import { env } from "process";
import { createWriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function run() {
  try {
    const config = parseConfig(env);
    if (!config.input_tag_name && !isTag(config.github_ref)) {
      throw new Error(`⚠️ GitHub Releases requires a tag`);
    }
    if (config.input_files) {
      const patterns = unmatchedPatterns(config.input_files);
      patterns.forEach((pattern) =>
        console.warn(`🤔 Pattern '${pattern}' does not match any files.`)
      );
      if (patterns.length > 0 && config.input_fail_on_unmatched_files) {
        throw new Error(`⚠️ There were unmatched files`);
      }
    }
    GitHub.plugin([
      require("@octokit/plugin-throttling"),
      require("@octokit/plugin-retry"),
    ]);
    const gh = new GitHub(config.github_token, {
      throttle: {
        onRateLimit: (retryAfter, options) => {
          console.warn(
            `Request quota exhausted for request ${options.method} ${options.url}`
          );
          if (options.request.retryCount === 0) {
            // only retries once
            console.log(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onAbuseLimit: (retryAfter, options) => {
          // does not retry, only logs a warning
          console.warn(
            `Abuse detected for request ${options.method} ${options.url}`
          );
        },
      },
    });
    let rel = await release(config, new Releaser(gh));
    if (config.input_files) {
      const files = paths(config.input_files);
      if (files.length == 0) {
        console.warn(`🤔 ${config.input_files} not include valid file.`);
      }
      if (config.input_create_zip) {
        const archive = Archiver("zip", { zlib: { level: 9 } }); // Max. compression
        const out_file = join(tmpdir(), config.input_filename || "upload.zip");
        const out = createWriteStream(out_file);
        const onerror = (err) => console.error(err);
        out.on("close", () => upload(gh, rel.upload_url, out_file));
        archive.on("error", onerror);
        archive.pipe(out);
        console.log(files);
        files.forEach((path) => archive.file(path, { name: path }));
        archive.finalize();
      } else {
        files.forEach(async (path) => {
          await upload(gh, rel.upload_url, path);
        });
      }
    }
    console.log(`🎉 Release ready at ${rel.html_url}`);
    setOutput("url", rel.html_url);
  } catch (error) {
    setFailed(error.message);
  }
}

run();
