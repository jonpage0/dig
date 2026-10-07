// The words Dig shows for the state of research, shared by the server (library_list and the saved-research card) and
// both views. Each is a lowercase tag whose fill pattern repeats its meaning, so no state rests on colour alone.

/**
 * The status `dig_finish` records in answer.md: whether the initiating thread's answer settles the question.
 * `partly-answered` means part of the question is still open. A failed search, a source that was down or a worker that
 * stopped is a limit the answer states; it does not make an answered question partly answered.
 */
export const ANSWER_STATUSES = ['answered', 'partly-answered', 'unanswered'];
const ANSWER_WORDS = { answered: 'answered', 'partly-answered': 'partly answered', unanswered: 'not answered' };
/** The tag for an answer.md status, or null for a value Dig does not write. */
export const answerWord = status => (typeof status === 'string' && Object.hasOwn(ANSWER_WORDS, status) ? ANSWER_WORDS[status] : null);
/** A dig's tag: its answer's status, else how far it got. */
export const digWord = (answerStatus, { answer, reports }) => answerWord(answerStatus) ?? (answer ? 'answer saved' : reports ? 'report saved' : 'started');

// A call receipt's status as a tag. Partial means part of the request failed while some results came back.
const CALL_WORDS = { success: 'results', partial: 'some results', empty: 'no results', failed: 'failed', cancelled: 'stopped', skipped: 'skipped' };
export const callWord = status => CALL_WORDS[status] ?? String(status ?? 'unknown');

/** A source card's own run status as its worker wrote it (complete, partial or failed), lowercase; null when absent. */
export const runWord = status => (typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : null);

// solid: done as intended; stripes: partly; warning: not done; dots: nothing yet. Words without a pattern (report
// saved, answer saved) get the plain tint.
const PATTERNS = {
  answered: 'solid', complete: 'solid', results: 'solid',
  'partly answered': 'stripes', partial: 'stripes', 'some results': 'stripes',
  'not answered': 'warning', failed: 'warning', stopped: 'warning', skipped: 'warning',
  started: 'dots', 'no results': 'dots',
};
export const patternOf = word => (Object.hasOwn(PATTERNS, word) ? PATTERNS[word] : null);
