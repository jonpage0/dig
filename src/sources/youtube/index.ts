import { defineSource, type SourcePlugin } from "../../core/plugin.ts";
import { youtubeCommentsAction } from "./comments.ts";
import {
  buildYouTubeRequest,
  formatInteraction,
  validInteractionId,
  youtubeAnalysisStatusAction,
  youtubeAnalyzeAction,
  youtubeInput,
  youtubeVideoUrlId,
} from "./gemini_video.ts";
import { cleanVtt, saveTranscript, youtubeAction, youtubeLibraryDir } from "./search.ts";
import { youtubeTranscriptAction, youtubeVideoId } from "./transcript.ts";

export {
  buildYouTubeRequest,
  cleanVtt,
  formatInteraction,
  saveTranscript,
  validInteractionId,
  youtubeAction,
  youtubeAnalysisStatusAction,
  youtubeAnalyzeAction,
  youtubeCommentsAction,
  youtubeInput,
  youtubeLibraryDir,
  youtubeTranscriptAction,
  youtubeVideoId,
  youtubeVideoUrlId,
};

export const youtubeSource: SourcePlugin = defineSource({
  id: "youtube",
  group: "video",
  label: "YouTube",
  description: "Video discovery, saved transcripts and focused Gemini video analysis",
  skills: ["youtube", "youtube-video"],
  helpers: ["youtube-summarizer"],
  env: ["OPENCODE_RESEARCH_GOOGLE_API_KEY", "SCRAPECREATORS_API_KEY", "GEMINI_API_KEY"],
  credential:
    "Optional OPENCODE_RESEARCH_GOOGLE_API_KEY for metadata search; yt-dlp for keyless search and local captions; optional SCRAPECREATORS_API_KEY for hosted transcripts and video comments; optional GEMINI_API_KEY for Gemini video analysis",
  requires: ["yt-dlp"],
  about:
    "Finds videos, saves transcripts, reads a video's comments and analyzes supplied public YouTube videos. The transcript method searches and checks creator claims; the optional YouTube video method uses Gemini 3.8 Flash for standard deeper analysis and Gemini 4 Argon for harder reasoning. Choose a focused Glimpse inspection when the question calls for close visual examination. Model descriptions and timestamps remain claims to check against the original video.",
  providers: [
    { name: "yt-dlp", url: "https://github.com/yt-dlp/yt-dlp" },
    { name: "YouTube Data API", url: "https://developers.google.com/youtube/v3" },
    { name: "Google Gemini API", url: "https://ai.google.dev/gemini-api/docs/video-understanding" },
  ],
  billing:
    "Local yt-dlp and YouTube Data API calls are free. Hosted transcripts and comments use reported ScrapeCreators credits. Gemini calls use your Google API account; returned token usage does not establish a per-call charge, so Dig records their cost as unknown.",
  logo: "youtube",
  actions: [
    youtubeAction,
    youtubeTranscriptAction,
    youtubeCommentsAction,
    youtubeAnalyzeAction,
    youtubeAnalysisStatusAction,
  ],
});

export default youtubeSource;
