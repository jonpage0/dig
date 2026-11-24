/**
 * `x_images`: fetch 1-4 pictures from X's public image host (`pbs.twimg.com`)
 * over `FreeHttp` (`freeBytes`) with SSRF validation + strict host allowlist,
 * returning image blocks directly (`returnsImages: true`, `billing: "free"`).
 */
import { Effect, Result, Schema } from "effect";
import { freeBytes } from "../../core/http.ts";
import {
  defineAction,
  failed,
  outcome,
  type ImageBlock,
} from "../../core/plugin.ts";
import { validatePublicUrlSyntax } from "../../core/ssrf.ts";
import { USER_AGENT } from "../../version.ts";

const HOST = "pbs.twimg.com";
const ALLOWED_HOSTS = new Set<string>([HOST]);
const SIZES = ["small", "medium", "large"] as const;
const MAX_IMAGES = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const TIMEOUT_MS = 60_000;
const ACCEPTED = `images must be 1 to ${MAX_IMAGES} X image links on https://${HOST}, as x_post, x_search_posts and the other X tools print them after "Media:" (a photo's link, or a video's preview link)`;

const formatBytes = (n: number): string => `${n.toLocaleString("en-US")} bytes`;

function validateImageLink(
  value: unknown,
): { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly error: string } {
  const text = String(value ?? "").trim();
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  const why = !url
    ? "is not a link"
    : url.protocol !== "https:"
      ? "is not https"
      : !ALLOWED_HOSTS.has(url.hostname)
        ? `is on ${url.hostname}, not ${HOST}`
        : url.username || url.password
          ? "carries credentials"
          : url.port
            ? "carries a port"
            : "";
  if (why) {
    return { ok: false, error: `${ACCEPTED}; ${JSON.stringify(text.slice(0, 200))} ${why}` };
  }
  const ssrf = validatePublicUrlSyntax(url!);
  if (ssrf instanceof Error) {
    return { ok: false, error: `${ACCEPTED}; ${ssrf.message}` };
  }
  return { ok: true, url: url! };
}

export const XImagesSchema = Schema.Struct({
  images: Schema.Array(Schema.String)
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_IMAGES))
    .annotate({
      description:
        "1-4 https://pbs.twimg.com/... links from Media: lines (photo or video preview). Returned in order.",
    }),
  size: Schema.optionalKey(Schema.Literals(SIZES)).annotate({
    description: "Photo size: small, medium (default) or large. Video previews ignore size.",
  }),
});

export const xImagesAction = defineAction({
  name: "x_images",
  description:
    `Look at 1-${MAX_IMAGES} pictures in X posts for free (no key) from returned Media: links. Give 1 to ${MAX_IMAGES} image links as x_post, x_search_posts and the other X tools print them after "Media:" (https://${HOST}/..., a photo's link or a video's preview link): each picture is fetched from X's image host and returned to you as an image, in the order given, after a text naming each link, whether it is shown, its media type and its size in bytes. ` +
    "size picks X's own sized variant of a photo: small, medium (default) or large; a video's preview image comes in one size. A picture that is redirected, is not a JPEG, PNG, WebP or GIF image, or is larger than 4 MB is not shown, with the reason. " +
    "Makes no X API request; no key and no charge. The pictures are not kept: a note of each one's link, media type and size stands in their place. What you say a picture shows is your own reading of it. For what a video shows, use xsearch.",
  schema: XImagesSchema,
  billing: "free",
  returnsImages: true,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      const asked = args.images;
      if (!Array.isArray(asked) || asked.length < 1 || asked.length > MAX_IMAGES) {
        return failed(
          `X images refused before any request: ${ACCEPTED}; ${Array.isArray(asked) ? `${asked.length} were given` : "none was given"}`,
        );
      }
      const size = args.size ?? "medium";
      if (!(SIZES as readonly string[]).includes(size)) {
        return failed(
          `X images refused before any request: size must be ${SIZES.join(", ")} (X's own sized variants of a photo); ${JSON.stringify(String(size).slice(0, 40))} is not one`,
        );
      }

      const links: URL[] = [];
      for (const raw of asked) {
        const checked = validateImageLink(raw);
        if (!checked.ok) return failed(`X images refused before any request: ${checked.error}`);
        links.push(checked.url);
      }

      const lines: string[] = [];
      const shown: ImageBlock[] = [];

      for (const [i, link] of links.entries()) {
        if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
        link.searchParams.set("name", size);

        const note = (
          status: number | string,
          type: string,
          length: number | null,
          resultText: string,
        ) => {
          ctx.keep(
            `image ${i + 1}`,
            status,
            `[picture not retained] ${link.href} · ${type || "no media type"} · ${length === null ? "size unknown" : formatBytes(length)} · ${resultText}`,
          );
          lines.push(
            `${i + 1}. ${link.href} · ${resultText} · ${type || "no media type"} · ${length === null ? "size unknown" : formatBytes(length)}`,
          );
        };

        const abortWait = Effect.callback<never, Error>((resume) => {
          if (ctx.signal.aborted) {
            resume(Effect.fail(new Error("Request aborted")));
            return;
          }
          const onAbort = () => resume(Effect.fail(new Error("Request aborted")));
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => ctx.signal.removeEventListener("abort", onAbort));
        });

        const fetched = yield* Effect.result(
          freeBytes(link.href, {
            headers: { "User-Agent": USER_AGENT },
            timeoutMs: TIMEOUT_MS,
            maxBytes: MAX_BYTES,
            followRedirects: false,
            signal: ctx.signal,
          }),
        );

        if (Result.isFailure(fetched)) {
          if (ctx.signal.aborted) return outcome("cancelled", "Research call cancelled");
          const msg = fetched.failure instanceof Error ? fetched.failure.message : "";
          const timedOut = /timed out/i.test(msg);
          note(
            "no response",
            "",
            null,
            `not shown: ${timedOut ? `no response within ${TIMEOUT_MS / 1000} seconds` : "the host could not be reached"}`,
          );
          continue;
        }

        const { status, contentType, bytes, exceededMaxBytes } = fetched.success;
        const type = contentType.split(";")[0].trim().toLowerCase();

        if (status >= 300 && status < 400) {
          note(status, type, null, `not shown: the host redirected it (HTTP ${status}), and Dig follows no redirect`);
          continue;
        }
        if (status < 200 || status >= 300) {
          note(status, type, null, `not shown: the host answered HTTP ${status}`);
          continue;
        }
        if (!(TYPES as readonly string[]).includes(type)) {
          note(status, type, bytes.byteLength, "not shown: not a JPEG, PNG, WebP or GIF image");
          continue;
        }
        if (exceededMaxBytes || bytes.byteLength > MAX_BYTES) {
          note(status, type, exceededMaxBytes ? null : bytes.byteLength, "not shown: larger than 4 MB");
          continue;
        }
        if (!bytes.byteLength) {
          note(status, type, 0, "not shown: the host sent an empty response");
          continue;
        }

        note(status, type, bytes.byteLength, "shown");
        shown.push({ data: Buffer.from(bytes).toString("base64"), mimeType: type });
      }

      const status = shown.length === links.length ? "success" : shown.length ? "partial" : "failed";
      const head =
        status === "failed"
          ? `ERROR: ${links.length === 1 ? "The picture asked for could not be shown" : `None of the ${links.length} pictures asked for could be shown`} (X's image host, ${HOST}, size ${size}).`
          : `Pictures from X's image host (${HOST}), size ${size}: ${shown.length} of ${links.length} shown, in the order asked.`;
      const close =
        status === "failed"
          ? []
          : [
              "",
              "What you see is each picture as X serves it now. What you say a picture shows is your own reading of it: label it as such in a report, and quote any text in the picture exactly.",
            ];

      return outcome(
        status,
        [head, "", ...lines, ...close].join("\n"),
        undefined,
        shown.length && status !== "failed" ? shown : undefined,
      );
    }),
});
