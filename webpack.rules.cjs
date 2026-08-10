const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = [
  {
    test: /\.tsx?$/,
    exclude: /node_modules/,
    use: { loader: "ts-loader", options: { transpileOnly: true } }
  },
  {
    test: /\.css$/,
    use: [MiniCssExtractPlugin.loader, "css-loader"]
  }
];
