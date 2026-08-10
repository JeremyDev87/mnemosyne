const rules = require("./webpack.rules.cjs");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = {
  module: { rules },
  plugins: [new MiniCssExtractPlugin({ filename: "[name].css" })],
  resolve: { extensions: [".js", ".ts", ".jsx", ".tsx", ".css"] },
  devtool: false,
  target: "web",
  node: false
};
