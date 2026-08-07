const webpack = require("webpack");
const rules = require("./webpack.rules.cjs");

module.exports = {
  entry: "./src/electron/main.ts",
  module: { rules },
  resolve: { extensions: [".js", ".ts", ".jsx", ".tsx", ".css"] },
  devtool: false,
  plugins: [new webpack.DefinePlugin({
    __MNEMOSYNE_E2E_BUILD__: JSON.stringify(process.env.MNEMOSYNE_E2E_BUILD === "1")
  })]
};
