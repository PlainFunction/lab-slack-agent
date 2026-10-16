// The test runner needs a Worker entry. Nothing is served from it.
export default {
  async fetch() { return new Response('slack-agent test worker', { status: 404 }) },
}
