/* eslint-disable filenames/match-exported */
import crypto from "crypto"
import { basename, dirname, extname, relative, sep } from "path"
import appRoot from "app-root-dir"
import basex from "base-x"
import json5 from "json5"

const base62 = basex("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
const root = appRoot.get()

const DEFAULT_LENGTH = 5
function hashString(input, precision = DEFAULT_LENGTH) {
  return base62
    .encode(
      crypto
        .createHash("sha256")
        .update(input)
        .digest()
    )
    .slice(0, precision)
}

function collectImportCallPaths(startPath) {
  const imports = []
  startPath.traverse({
    Import: function Import(importPath) {
      imports.push(importPath)
    }
  })

  return imports
}

function getImportArgPath(path) {
  return path.parentPath.get("arguments")[0]
}

function getSimplifiedPrefix(request) {
  let simplified = request.replace(/^[./]+|(\.js$)/g, "")
  if (simplified.endsWith("/")) {
    simplified =
      `${simplified
        .slice(0, -1)
        .split("/")
        .pop()}-`
  } else {
    simplified = ""
  }

  return simplified
}

const visited = Symbol("visited")

function processImport(path, state) {
  if (path[visited]) {
    return
  }
  path[visited] = true

  const importArg = getImportArgPath(path)
  const importArgNode = importArg.node
  const { quasis, expressions, leadingComments } = importArgNode

  const requester = dirname(state.file.opts.filename)
  const request = quasis ? quasis[0].value.cooked : importArgNode.value

  // There exists the possibility of non usable value. Typically only
  // when the user has import() statements with other complex data, but
  // not a string or template string. We handle this gracefully by ignoring.
  if (request == null) {
    return
  }

  const jsonContent = {}

  // Try to parse all previous comments
  if (leadingComments) {
    leadingComments.forEach((comment, index) => {
      // Skip empty comments
      if (!comment.value.trim()) {
        return
      }

      // Webpack magic comments are declared as JSON5 but miss the curly braces.
      let parsed
      try {
        parsed = json5.parse(`{${comment.value}}`)
      } catch (err) {
        // Most probably a non JSON5 comment
        return
      }

      // Skip comment processing if it already contains a chunk name
      if (parsed.webpackChunkName) {
        jsonContent.webpackChunkName = true
        return
      }

      // We copy over all fields and...
      for (const key in parsed) {
        jsonContent[key] = parsed[key]
      }

      // Cleanup the parsed comment afterwards
      comment.value = ""
    })
  }

  if (!jsonContent.webpackChunkName) {
    const hasExpressions = expressions && expressions.length > 0

    // Append [request] as placeholder for dynamic part in WebpackChunkName
    const fullRequest = hasExpressions ? `${request}[request]` : request

    // Prepend some clean identifier of the static part when using expressions.
    // This is not required to work, but helps users to identify different chunks.
    const requestPrefix = hasExpressions ? getSimplifiedPrefix(request) : ""

    // Cleanup combined request to not contain any paths info
    const plainRequest = basename(fullRequest, extname(fullRequest))

    // Normalize requester between different OSs
    const normalizedRequester = relative(root, requester)
      .split(sep)
      .join("/")

    // Hash request origin and request
    const importHash = hashString(`${normalizedRequester}::${request}`)

    // Add our chunk name to the previously parsed values
    jsonContent.webpackChunkName = `${requestPrefix}${plainRequest}-${importHash}`

    // Convert to string and remove outer JSON object symbols {}
    const magicComment = json5.stringify(jsonContent).slice(1, -1)

    // Add as a new leading comment
    importArg.addComment("leading", magicComment)
  }
}

export default function smartWebpackImport({ types, template }) {
  return {
    name: "smart-webpack-import",
    visitor: {
      CallExpression(path, state) {
        const imports = collectImportCallPaths(path)
        imports.forEach((importCall) => processImport(importCall, state))
      }
    }
  }
}

export function shouldPrintComment(comment) {
  // Keep pure function markers which are generated by some plugins
  // See sideEffects option: https://github.com/mishoo/UglifyJS2
  if ((/[#@]__PURE__/).exec(comment)) {
    return true
  }

  // Keep JSON5 magic comments used for Webpack hints
  if ((/^\s?webpack[A-Z][A-Za-z]+:/).exec(comment)) {
    return true
  }

  return false
}
