const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    entry: {
      'background/service-worker': './src/background/service-worker.js',
      'sidepanel/sidepanel': './src/sidepanel/sidepanel.js',
      'content/universal': './src/content/universal.js',
      'offscreen/offscreen': './src/offscreen/offscreen.js',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
    },
    devtool: isDev ? 'inline-source-map' : false,
    // Enable WebAssembly and async modules for Transformers.js
    experiments: {
      asyncWebAssembly: true,
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: 'babel-loader',
        },
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'public', to: '', noErrorOnMissing: true, globOptions: { dot: true, ignore: ['**/.gitkeep'] } },
          { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel.html' },
          { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
          {
            from: 'public/models/silero_vad_v5.onnx',
            to: 'models/silero_vad_v5.onnx',
            noErrorOnMissing: false,
          },
          // Copy ONNX Runtime WASM files for local bundling (Chrome MV3 requirement)
          // Chrome extensions cannot load remotely hosted code from CDNs
          {
            from: 'node_modules/onnxruntime-web/dist/*.wasm',
            to: 'onnx/[name][ext]',
            noErrorOnMissing: false,
          },
          {
            from: 'node_modules/onnxruntime-web/dist/*.mjs',
            to: 'onnx/[name][ext]',
            noErrorOnMissing: false,
          },
        ],
      }),
    ],
    watchOptions: {
      ignored: /node_modules/,
    },
  };
};
