/**
 * Create a comment-to-DM campaign from the command line.
 *
 * The dashboard is the normal way to do this. This script exists for the other
 * side of the workflow: a content project that has just published a post and
 * knows, at that moment, which keyword its caption told people to comment. It
 * writes the same Automation row the dashboard writes — the worker reads the
 * table, not the UI, so a row created here behaves identically.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/create-campaign.ts \
 *     --account keonse_ai \
 *     --name "AI Act carousel" \
 *     --keywords "GUIDA,GUIDE" \
 *     --message "Ecco la guida che hai chiesto: https://..." \
 *     --post 17912345678901234
 *
 * Post targeting — exactly one of:
 *   --post <mediaId>   bind to one published post
 *   --any-post         fire on comments under any post on the account
 *   --next-reel        arm for the next reel published (pendingNextReel)
 *
 * Optional:
 *   --public-reply "<text>"   also post a visible reply under the comment
 *   --dm-trigger              also fire on inbound DMs / Story replies
 *   --require-follow          ask for a follow before revealing the message
 *   --follow-prompt "<text>"  what the follow request says
 *   --follow-button "<label>" label of the button that re-checks the follow
 *   --partial-match           match keywords inside longer words
 *   --inactive                create the campaign switched off
 *   --dry-run                 print what would be created, write nothing
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${key} is required`);
  }
  return value.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const accountUsername = requireString(args, "account");
  const name = requireString(args, "name");
  const dmMessage = requireString(args, "message");
  const keywords = requireString(args, "keywords")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  if (keywords.length === 0) {
    throw new Error("--keywords must list at least one keyword");
  }

  const postId = typeof args.post === "string" ? args.post.trim() : null;
  const matchAnyPost = args["any-post"] === true;
  const pendingNextReel = args["next-reel"] === true;

  // Meta delivers a comment webhook per media id. A campaign that names no
  // target would match nothing and look broken, so require an explicit choice
  // rather than silently defaulting to one.
  const targets = [postId ? "post" : null, matchAnyPost ? "any-post" : null, pendingNextReel ? "next-reel" : null].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error("choose exactly one of --post <mediaId>, --any-post, --next-reel (got: " + (targets.join(", ") || "none") + ")");
  }

  const publicReplyMessage = typeof args["public-reply"] === "string" ? args["public-reply"].trim() : null;

  const followPromptMessage = typeof args["follow-prompt"] === "string" ? args["follow-prompt"].trim() : null;
  const followPromptButtonLabel = typeof args["follow-button"] === "string" ? args["follow-button"].trim() : null;
  const requireFollow = args["require-follow"] === true;

  // The prompt texts are only ever read when the gate is on. Accepting them
  // without it would silently do nothing, which reads as a working follow gate
  // to whoever set it up.
  if (!requireFollow && (followPromptMessage || followPromptButtonLabel)) {
    throw new Error("--follow-prompt / --follow-button require --require-follow");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(databaseUrl) });

  try {
    const account = await prisma.instagramAccount.findFirst({
      where: { username: accountUsername },
      select: { id: true, username: true, workspaceId: true },
    });

    if (!account) {
      const available = await prisma.instagramAccount.findMany({ select: { username: true } });
      throw new Error(
        `no connected Instagram account named "${accountUsername}". Connected: ${available.map((a) => a.username).join(", ") || "none"}`
      );
    }

    const data = {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      name,
      keywords,
      dmMessage,
      postId,
      matchAnyPost,
      pendingNextReel,
      wholeWordMatch: args["partial-match"] !== true,
      dmTriggerEnabled: args["dm-trigger"] === true,
      publicReplyEnabled: publicReplyMessage !== null,
      publicReplyMessage,
      publicReplyMessages: publicReplyMessage ? [publicReplyMessage] : [],
      requireFollow,
      followPromptMessage,
      followPromptButtonLabel,
      isActive: args.inactive !== true,
    };

    if (args["dry-run"] === true) {
      console.log("dry run, nothing written:");
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const campaign = await prisma.automation.create({ data, select: { id: true, name: true, isActive: true } });

    console.log(`created campaign ${campaign.id} — "${campaign.name}" (${campaign.isActive ? "active" : "inactive"})`);
    console.log(`account: @${account.username}`);
    console.log(`keywords: ${keywords.join(", ")}${data.wholeWordMatch ? " (whole word)" : " (partial match)"}`);
    console.log(`target: ${postId ? `post ${postId}` : matchAnyPost ? "any post" : "next reel published"}`);
    if (requireFollow) {
      console.log("follow gate: on — non-followers get the prompt first, confirmed followers get the message straight away");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
