import { test } from "node:test";
import { expect } from "expect";
import { cleanVtt } from "./youtube.js";

// YouTube's automatic captions start with a header (WEBVTT, Kind, Language) and roll: each cue repeats the previous
// line above the new one, with a 10 ms cue between that holds only the finished line. The speaker says "The answer
// is yes." twice, a minute apart.
const rolling = [
	"WEBVTT",
	"Kind: captions",
	"Language: en",
	"",
	"00:00:00.160 --> 00:00:02.869 align:start position:0%",
	" ",
	"The<00:00:00.480><c> answer</c><00:00:00.800><c> is</c><00:00:01.120><c> yes.</c>",
	"",
	"00:00:02.869 --> 00:00:02.879 align:start position:0%",
	"The answer is yes.",
	" ",
	"",
	"00:00:02.879 --> 00:00:05.150 align:start position:0%",
	"The answer is yes.",
	"Here<00:00:03.200><c> is</c><00:00:03.520><c> why.</c>",
	"",
	"00:00:05.150 --> 00:00:05.160 align:start position:0%",
	"Here is why.",
	" ",
	"",
	"00:01:00.000 --> 00:01:02.000 align:start position:0%",
	"Here is why.",
	"The<00:01:00.300><c> answer</c><00:01:00.600><c> is</c><00:01:00.900><c> yes.</c>",
	"",
].join("\n");

test("the transcript cleaner drops the header and rolling caption overlap but keeps a sentence said again later", () => {
	expect(cleanVtt(rolling)).toBe("The answer is yes. Here is why. The answer is yes.");
});
