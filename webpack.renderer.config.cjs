const rules = require("./webpack.rules.cjs");

module.exports = {
  module: { rules },
  resolve: { extensions: [".js", ".ts", ".jsx", ".tsx", ".css"] },
  devtool: false,
  target: "web",
  node: false
};
