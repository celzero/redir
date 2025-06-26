// developers.cloudflare.com/workers/cli-wrangler/configuration#modules
// archive.is/FDky9
module.exports = {
  entry: "./src/index.js",
  target: ["webworker", "es2025"],
  mode: "production",
  // enable devtool in development
  // devtool: 'eval-cheap-module-source-map',

  optimization: {
    usedExports: true,
    minimize: true,
  },

  // github.com/serverless-dns/serverless-dns/blob/d8868b2683/webpack.config.cjs#L21
  plugins: [
    // remove "node:" prefix from imports as target is webworker
    // stackoverflow.com/a/73351738 and github.com/vercel/next.js/issues/28774
    // github.com/Avansai/next-multilingual/blob/aaad6a7204/src/config/index.ts#L750
    new webpack.NormalModuleReplacementPlugin(/node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
  ],

  experiments: {
    outputModule: true,
  },

  // stackoverflow.com/a/68916455
  output: {
    library: {
      type: "module",
    },
    filename: "worker.js",
    module: true,
  },
};
