/**
 * Babel is CommonJS on purpose: Metro loads this file with `require`, and the package
 * deliberately does not declare `"type": "module"` for that reason.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
