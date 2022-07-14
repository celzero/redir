/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npx wrangler dev src/index.js` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npx wrangler publish src/index.js --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

 const tx = new Map();
 tx.set("sponsor", "https://donate.stripe.com/aEU00s632gus8hyfYZ?prefilled_email=anonymous.donor%40rethinkdns.com");

function redirect(r, home) {
  try {
      const url = new URL(r.url);
      const path = url.pathname;
      // x.tld/a/b/c/ => ["", "a", "b", "c", ""]
      const p = path.split("/");
      if (p.length >= 3 && p[2].length > 0 && p[2].length <= 10) {
          const w = p[2];
          if (tx.has(w)) {
              // redirect to where tx wants us to
              const redirurl = new URL(tx.get(w));
              for (const paramsin of url.searchParams) {
                  redirurl.searchParams.set(...paramsin);
              }
              return r302(redirurl.toString());
          } else {
              // todo: redirect up the parent direct to the same location
              // that is, x.tld/r/w => x.tld/w (handle the redir in this worker!)
              // return r302(`../${w}`);
              // fall-through, for now
          }
      }
  } catch(ex) {
      console.error(ex);
  }
  return r302(home);
}

function r302(where) {
    return new Response("Redirecting...", {
        status: 302, // redirect
        headers: {location: where},
    });
}

export default {
    async fetch(request, env, ctx) {
        return redirect(request, env.REDIR_CATCHALL);
    },
};
