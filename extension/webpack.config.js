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
        ],
      }),
    ],
    watchOptions: {
      ignored: /node_modules/,
    },
  };
};
