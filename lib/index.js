const path = require("path");
const fs = require("fs-extra");
const normalize = require("normalize-path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;

/**  @type {string[]} */
let files = [];

class WepyPluginCopyFile {
  options = {};

  timer = null;

  constructor(options = {}) {
    this.options = options;
  }

  copy() {
    const dist = normalize(this.options.output);
    const target = normalize(this.options.target);

    const appPath = path.join(dist, "app.js");

    if (!fs.existsSync(appPath)) {
      this.loop();
      return;
    }

    const originalCode = fs.readFileSync(appPath).toString();
    const wepyApp = `const preApp = App;
    let options = null;
    function WepyApp(opts) {
      options = opts; 
    }
    App = function (opts) {
      if (!options) {
        options = opts;
      }
      Object.keys(opts || {}).forEach((key) => {
        if (typeof options[key] === "function") {
          const temp = options[key];
          options[key] = function (...lifetimesOpts) {
            temp.apply(this, lifetimesOpts);
            opts[key].apply(this, lifetimesOpts);
          }
        } else {
          options[key] = opts[key];
        }
      });
      const onLaunchTemp = options.onLaunch;
      options.onLaunch = function () {
        if (typeof wx.__beforeOnLaunch__ === "function") {
          wx.__beforeOnLaunch__()
        }
        if (typeof onLaunchTemp === "function") {
          onLaunchTemp.apply(this, arguments);
        }
      }
      preApp(options);
    };`;
    const newCode = `${wepyApp}${originalCode}`;

    const ast = parser.parse(newCode, {
      sourceType: "unambiguous",
    });

    traverse(ast, {
      CallExpression(path, state) {
        if (path.node.callee.name === "App") {
          path.node.callee.name = "WepyApp";
        }
      },
    });

    const { code } = generate(ast);

    const newFile = path.join(target, "wepy-app.js");

    const copyFilter =
      typeof this.options.filter === "function"
        ? this.options.filter
        : () => false;

    if (files.length >= 5) {
      fs.copySync(dist, target, {
        filter(src, dest) {
          if (
            copyFilter(src, dest) ||
            src.indexOf("/dist/app.js") > -1 ||
            src.indexOf("/dist/app.json") > -1
          ) {
            return false;
          }

          return true;
        },
      });
    } else {
      files.forEach((src) => {
        const relativePath = path.relative(dist, src);

        if (src.indexOf("/dist/app.json") > -1) {
          copyAppJson();
        }

        fs.copySync(src, path.join(target, relativePath), {
          filter(src, dest) {
            if (
              copyFilter(src, dest) ||
              src.indexOf("/dist/app.js") > -1 ||
              src.indexOf("/dist/app.json") > -1
            ) {
              return false;
            }

            return true;
          },
        });
      });
    }
    files = [];

    if (this.options.sourceApp) {
      this.modifyWepyAppJsAfterMerge();
    } else {
      fs.writeFileSync(newFile, code);
    }

    function copyAppJson() {
      const uniAppJson = path.join(target, "uni-app.json");

      if (!fs.existsSync(uniAppJson)) {
        return;
      }

      const originalApp = JSON.parse(
        fs.readFileSync(path.join(dist, "app.json")).toString(),
      );

      const uniappApp = JSON.parse(
        fs.readFileSync(path.join(target, "uni-app.json")).toString(),
      );

      const appJson = {
        ...uniappApp,
        ...originalApp,
      };

      appJson.pages = [...originalApp.pages, ...uniappApp.pages];
      appJson.subPackages = [
        ...(originalApp?.subPackages ?? []),
        ...(uniappApp?.subPackages ?? []),
        ...(originalApp?.subpackages ?? []),
        ...(uniappApp?.subpackages ?? []),
      ];

      delete appJson.subpackages;

      fs.writeFileSync(
        path.join(target, "app.json"),
        JSON.stringify(appJson, null, 2),
      );
    }

    if (fs.existsSync(this.options.copyDir) && this.options.copyDir) {
      fs.copySync(this.options.copyDir, target);

      const copyFilePath = path.join(this.options.copyDir, "app.js");
      const copyFile = fs.readFileSync(copyFilePath).toString();

      if (!fs.existsSync(copyFilePath)) {
        return;
      }

      const newApp = `require("./wepy-app.js");\n${copyFile}`;

      fs.writeFileSync(path.join(target, "app.js"), newApp);

      const originalApp = JSON.parse(
        fs.readFileSync(path.join(dist, "app.json")).toString(),
      );
      const uniappApp = JSON.parse(
        fs.readFileSync(path.join(this.options.copyDir, "app.json")).toString(),
      );

      let appJson = mergeJson(originalApp, uniappApp);

      if (typeof this.options.filterJson === "function") {
        appJson =
          this.options.filterJson(appJson, originalApp, uniappApp) || appJson;
      }

      fs.writeFileSync(
        path.join(target, "app.json"),
        JSON.stringify(appJson, null, 2),
      );
    }
  }

  loop() {
    clearTimeout(this.timer);
    this.timer = null;

    this.timer = setTimeout(() => {
      this.copy();
    }, 500);
  }

  apply(data) {
    if (this.options.isClose) {
      data.next();
      return;
    }

    let file = data.file;

    if (["wxml", "json", "wxss", "wxs"].includes(data.type)) {
      const relativePath = path.relative(this.options.input, file);
      file = path.join(this.options.output, relativePath);
    }

    if (file.includes("/dist/")) {
      files.push(file);
    }

    this.loop();
    data.next();
  }

  /**
   * 迁移完app.wpy后使用固定的wepy-app.js
   */
  modifyWepyAppJsAfterMerge() {
    fs.copyFileSync(
      this.options.sourceApp,
      path.join(this.options.target, "wepy-app.js"),
    );
  }
}

function mergeJson(target, source) {
  const targetProperty = Object.keys(target);

  const appJson = Object.create(null);

  targetProperty.forEach((property) => {
    if (typeof target[property] !== "object") {
      appJson[property] =
        source[property] !== null && typeof source[property] !== "undefined"
          ? source[property]
          : target[property];

      return;
    }

    if (Array.isArray(target[property])) {
      appJson[property] = [...target[property], ...(source[property] || [])];
      return;
    }

    appJson[property] = {
      ...target[property],
      ...(source[property] || Object.create(null)),
    };
  });

  const remainingProperties = Object.keys(source).filter((item) => {
    return !targetProperty.includes(item);
  });

  remainingProperties.forEach((item) => {
    appJson[item] = source[item];
  });

  appJson.pages = deleteRepeatItem(appJson.pages);

  appJson.subPackages =
    deleteRepeatItem(
      [...(appJson.subPackages || []), ...(appJson.subpackages || [])],
      (pre, current) => {
        return Boolean(pre.find((item) => item.root === current.root));
      },
    ) || [];

  delete appJson.subpackages;

  return appJson;
}

function deleteRepeatItem(data, compare) {
  return data.reduce((pre, current) => {
    if (typeof compare === "function") {
      if (compare(pre, current)) {
        return pre;
      }

      pre.push(current);

      return pre;
    }

    if (pre.includes(current)) {
      return pre;
    }

    pre.push(current);

    return pre;
  }, []);
}

module.exports = WepyPluginCopyFile;
