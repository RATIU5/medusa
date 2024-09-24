import { ArrayExpression } from "@babel/types"
import {
  isValidCustomFieldDisplayPath,
  isValidCustomFieldDisplayZone,
  isValidCustomFieldFormConfigPath,
  isValidCustomFieldFormFieldPath,
  isValidCustomFieldFormTab,
  isValidCustomFieldFormZone,
  isValidCustomFieldModel,
  type CustomFieldContainerZone,
  type CustomFieldFormTab,
  type CustomFieldFormZone,
  type CustomFieldModel,
} from "@medusajs/admin-shared"
import fs from "fs/promises"
import { outdent } from "outdent"
import {
  ExportDefaultDeclaration,
  File,
  isArrayExpression,
  isCallExpression,
  isIdentifier,
  isObjectExpression,
  isObjectProperty,
  isStringLiteral,
  NodePath,
  ObjectExpression,
  ObjectProperty,
  parse,
  ParseResult,
  traverse,
} from "../babel"
import { logger } from "../logger"
import { crawl, getParserOptions } from "../utils"

type FormConfigField = {
  name: string
  defaultValue: string
  validation: string
}

type FormConfig = {
  zone: CustomFieldFormZone
  fields: FormConfigField[]
}

type FormFieldSectionField = {
  name: string
  label: string
  description: string
  Component: string
  validation: string
}

type FormFieldSection = {
  zone: CustomFieldFormZone
  tab?: CustomFieldFormTab
  fields: FormFieldSectionField[]
}

type Link = {
  field: string
}

type Display = {
  zone: CustomFieldContainerZone
  Component: string
}

type CustomFieldResult = {
  import: string
  model: CustomFieldModel
  configs: FormConfig[] | null
  fields: FormFieldSection[] | null
  displays: Display[] | null
  link: Link
}

export async function createCustomFieldEntrypoint(sources: Set<string>) {
  const files = await getFilesFromSources(sources)
  const results = await getCustomFieldResults(files)

  const imports = results.map((result) => result.import).flat()
  const code = generateCode(results)

  return {
    imports,
    code,
  }
}

async function getFilesFromSources(sources: Set<string>): Promise<string[]> {
  const files = (
    await Promise.all(
      Array.from(sources).map(async (source) =>
        crawl(`${source}/custom-fields`)
      )
    )
  ).flat()
  return files
}

function generateCode(results: CustomFieldResult[]): string {
  const groupedByModel = new Map<CustomFieldModel, CustomFieldResult[]>()

  results.forEach((result) => {
    const model = result.model
    if (!groupedByModel.has(model)) {
      groupedByModel.set(model, [])
    }
    groupedByModel.get(model)!.push(result)
  })

  const segments: string[] = []

  groupedByModel.forEach((results, model) => {
    const links = results.map((result) => result.link.field).join(",\n")
    const configs = results
      .map((result) => formatConfig(result.configs))
      .filter((config) => config !== "")
      .join(",\n")
    const fields = results
      .map((result) => formatFields(result.fields))
      .filter((field) => field !== "")
      .join(",\n")
    const displays = results
      .map((result) => formatDisplays(result.displays))
      .filter((display) => display !== "")
      .join(",\n")

    segments.push(outdent`
      ${model}: {
        links: [
          ${links}
        ],
        configs: [
          ${configs}
        ],
        fields: [
          ${fields}
        ],
        displays: [
          ${displays}
        ],
      }
    `)
  })

  return outdent`
    customFields: {
      ${segments.join("\n")}
    }
  `
}

function formatDisplays(displays: Display[] | null): string {
  if (!displays || displays.length === 0) {
    return ""
  }

  return outdent`
    ${displays
      .map(
        (display) => outdent`
        {
          zone: "${display.zone}",
          Component: ${display.Component},
        }
      `
      )
      .join(",\n")}
  `
}

function formatConfig(configs: FormConfig[] | null): string {
  if (!configs || configs.length === 0) {
    return ""
  }

  return outdent`
    ${configs
      .map(
        (config) => outdent`
        {
          zone: "${config.zone}",
          fields: {
            ${config.fields
              .map(
                (field) => `${field.name}: {
              defaultValue: ${field.defaultValue},
              validation: ${field.validation},
            }`
              )
              .join(",\n")}
          },
        }
      `
      )
      .join(",\n")}
  `
}

function formatFields(fields: FormFieldSection[] | null): string {
  if (!fields || fields.length === 0) {
    return ""
  }

  return fields
    .map(
      (field) => outdent`
        {
          zone: "${field.zone}",
          tab: ${field.tab === undefined ? undefined : `"${field.tab}"`},
          fields: {
            ${field.fields
              .map(
                (field) => `${field.name}: {
              validation: ${field.validation},
              Component: ${field.Component},
              label: ${field.label},
              description: ${field.description},
            }`
              )
              .join(",\n")}
          },
        }
      `
    )
    .join(",\n")
}

async function getCustomFieldResults(
  files: string[]
): Promise<CustomFieldResult[]> {
  return (
    await Promise.all(files.map(async (file, index) => parseFile(file, index)))
  ).filter(Boolean) as CustomFieldResult[]
}

async function parseFile(
  file: string,
  index: number
): Promise<CustomFieldResult | null> {
  const content = await fs.readFile(file, "utf8")
  let ast: ParseResult<File>

  try {
    ast = parse(content, getParserOptions(file))
  } catch (e) {
    logger.error(
      `An error occurred while parsing ${file}. If the file has a valid custom field config, it will not be included in the generated entrypoint. See the below error for more details:\n${e}`
    )
    return null
  }

  const import_ = generateImport(file, index)

  let configs: FormConfig[] | null = []
  let fields: FormFieldSection[] | null = []
  let displays: Display[] | null = []
  let link: Link | null = null
  let model: CustomFieldModel | null = null
  try {
    traverse(ast, {
      ExportDefaultDeclaration(path) {
        const _model = getModel(path, file)

        if (!_model) {
          return
        }

        model = _model
        link = getLink(path, index, file)
        configs = getConfigs(path, model, index, file)
        fields = getFields(path, model, index, file)
        displays = getDisplays(path, model, index, file)
      },
    })
  } catch (err) {
    logger.error(
      `An error occurred while traversing ${file}. If the file has a valid custom field config, it will not be included in the generated entrypoint. See the below error for more details:\n${err}`
    )
    return null
  }

  if (!link || !model) {
    return null
  }

  return {
    import: import_,
    model,
    link,
    configs,
    fields,
    displays,
  }
}

function generateCustomFieldConfigName(index: number): string {
  return `CustomFieldConfig${index}`
}

function generateImport(file: string, index: number): string {
  return `import ${generateCustomFieldConfigName(index)} from "${file}"`
}

function getFields(
  path: NodePath<ExportDefaultDeclaration>,
  model: CustomFieldModel,
  index: number,
  file: string
): FormFieldSection[] | null {
  const formArray = getFormsArgument(path, file)

  if (!formArray) {
    return null
  }

  const forms: FormFieldSection[] = []

  formArray.elements.forEach((element, j) => {
    if (!isObjectExpression(element)) {
      return
    }

    const zoneProperty = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "zone" })
    ) as ObjectProperty | undefined

    if (!zoneProperty) {
      logger.warn(
        `The 'zone' property is missing from the ${j} entry in the 'forms' property in ${file}. The 'zone' property is required to load a custom field form.`
      )
      return
    }

    if (!isStringLiteral(zoneProperty.value)) {
      logger.warn(
        `The 'zone' property in the ${j} entry in the 'forms' property in ${file} is not a string literal. The 'zone' property must be a string literal, e.g. 'general' or 'attributes'.`
      )
      return
    }

    const tabProperty = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "tab" })
    ) as ObjectProperty | undefined

    let tab: string | undefined

    if (tabProperty) {
      if (!isStringLiteral(tabProperty.value)) {
        logger.warn(
          `The 'tab' property in the ${j} entry in the 'forms' property in ${file} is not a string literal. The 'tab' property must be a string literal, e.g. 'general' or 'attributes'.`
        )
        return
      }

      tab = tabProperty.value.value
    }

    if (tab && !isValidCustomFieldFormTab(tab)) {
      logger.warn(
        `The 'tab' property in the ${j} entry in the 'forms' property in ${file} is not a valid custom field form tab for the ${model} model. Received: ${tab}.`
      )
      return
    }

    const zone = zoneProperty.value.value
    const fullPath = getFormEntryFieldPath(model, zone, tab)

    if (
      !isValidCustomFieldFormZone(zone) ||
      !isValidCustomFieldFormFieldPath(fullPath)
    ) {
      logger.warn(
        `The 'zone' and 'tab' properties in the ${j} entry in the 'forms' property in ${file} are not a valid custom field form zone and tab for the ${model} model. Received: zone: ${zone}, tab: ${tab}.`
      )
      return
    }

    const fieldsObject = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "fields" })
    ) as ObjectProperty | undefined

    if (!fieldsObject) {
      logger.warn(
        `The 'fields' property is missing from the ${j} entry in the 'forms' property in ${file}. The 'fields' property is required to load a custom field form.`
      )
      return
    }

    const fields: FormFieldSectionField[] = []

    if (!isObjectExpression(fieldsObject.value)) {
      logger.warn(
        `The 'fields' property in the ${j} entry in the 'forms' property in ${file} is malformed. The 'fields' property must be an object.`
      )
      return
    }

    fieldsObject.value.properties.forEach((field) => {
      if (!isObjectProperty(field) || !isIdentifier(field.key)) {
        return
      }

      const name = field.key.name

      if (!isObjectExpression(field.value)) {
        logger.warn(
          `The '${name}' property in the 'fields' property in the ${j} entry in the 'forms' property in ${file} is malformed. The property must be an object.`
        )
        return
      }

      const labelProperty = field.value.properties.find(
        (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "label" })
      ) as ObjectProperty | undefined

      const descriptionProperty = field.value.properties.find(
        (p) =>
          isObjectProperty(p) && isIdentifier(p.key, { name: "description" })
      ) as ObjectProperty | undefined

      const componentProperty = field.value.properties.find(
        (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "component" })
      ) as ObjectProperty | undefined

      const validationProperty = field.value.properties.find(
        (p) =>
          isObjectProperty(p) && isIdentifier(p.key, { name: "validation" })
      ) as ObjectProperty | undefined

      const label = getFormFieldSectionValue(
        !!labelProperty,
        index,
        j,
        name,
        "label"
      )
      const description = getFormFieldSectionValue(
        !!descriptionProperty,
        index,
        j,
        name,
        "description"
      )
      const component = getFormFieldSectionValue(
        !!componentProperty,
        index,
        j,
        name,
        "component"
      )
      const validation = getFormFieldSectionValue(
        !!validationProperty,
        index,
        j,
        name,
        "validation"
      )

      fields.push({
        name,
        label,
        description,
        Component: component,
        validation,
      })
    })

    forms.push({
      zone,
      tab: tab as CustomFieldFormTab | undefined,
      fields,
    })
  })

  return forms.length > 0 ? forms : null
}

function getFormFieldSectionValue(
  exists: boolean,
  fileIndex: number,
  formIndex: number,
  fieldKey: string,
  value: string
): string {
  if (!exists) {
    return "undefined"
  }

  const import_ = generateCustomFieldConfigName(fileIndex)
  return `${import_}.forms[${formIndex}].fields.${fieldKey}.${value}`
}

function getFormEntryFieldPath(
  model: CustomFieldModel,
  zone: string,
  tab?: string
): string {
  return `${model}.${zone}.${tab ? `${tab}.` : ""}$field`
}

function getConfigs(
  path: NodePath<ExportDefaultDeclaration>,
  model: CustomFieldModel,
  index: number,
  file: string
): FormConfig[] | null {
  const formArray = getFormsArgument(path, file)

  if (!formArray) {
    return null
  }

  const configs: FormConfig[] = []

  formArray.elements.forEach((element, j) => {
    if (!isObjectExpression(element)) {
      return
    }

    const zoneProperty = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "zone" })
    ) as ObjectProperty | undefined

    if (!zoneProperty) {
      logger.warn(
        `The 'zone' property is missing from the ${j} entry in the 'forms' property in ${file}. The 'zone' property is required to load a custom field form.`
      )
      return
    }

    if (!isStringLiteral(zoneProperty.value)) {
      logger.warn(
        `The 'zone' property in the ${j} entry in the 'forms' property in ${file} is not a string literal. The 'zone' property must be a string literal, e.g. 'general' or 'attributes'.`
      )
      return
    }

    const zone = zoneProperty.value.value
    const fullPath = getFormEntryConfigPath(model, zone)

    if (
      !isValidCustomFieldFormZone(zone) ||
      !isValidCustomFieldFormConfigPath(fullPath)
    ) {
      logger.warn(
        `The 'zone' property in the ${j} entry in the 'forms' property in ${file} is not a valid custom field form zone for the ${model} model. Received: ${zone}.`
      )
      return
    }

    const fieldsObject = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "fields" })
    ) as ObjectProperty | undefined

    if (!fieldsObject) {
      logger.warn(
        `The 'fields' property is missing from the ${j} entry in the 'forms' property in ${file}. The 'fields' property is required to load a custom field form.`
      )
      return
    }

    const fields: FormConfigField[] = []

    if (!isObjectExpression(fieldsObject.value)) {
      logger.warn(
        `The 'fields' property in the ${j} entry in the 'forms' property in ${file} is malformed. The 'fields' property must be an object.`
      )
      return
    }

    fieldsObject.value.properties.forEach((field) => {
      if (!isObjectProperty(field) || !isIdentifier(field.key)) {
        return
      }

      const name = field.key.name

      if (!isObjectExpression(field.value)) {
        logger.warn(
          `The '${name}' property in the 'fields' property in the ${j} entry in the 'forms' property in ${file} is malformed. The property must be an object.`
        )
        return
      }

      const defaultValueProperty = field.value.properties.find(
        (p) =>
          isObjectProperty(p) && isIdentifier(p.key, { name: "defaultValue" })
      ) as ObjectProperty | undefined

      if (!defaultValueProperty) {
        logger.warn(
          `The 'defaultValue' property is missing from the ${j} entry in the 'forms' property in ${file}. The 'defaultValue' property is required.`
        )
        return
      }

      const validationProperty = field.value.properties.find(
        (p) =>
          isObjectProperty(p) && isIdentifier(p.key, { name: "validation" })
      ) as ObjectProperty | undefined

      if (!validationProperty) {
        logger.warn(
          `The 'validation' property is missing from the ${j} entry in the 'forms' property in ${file}. The 'validation' property is required.`
        )
        return
      }

      const defaultValue = getFormFieldValue(index, j, name, "defaultValue")
      const validation = getFormFieldValue(index, j, name, "validation")

      fields.push({
        name,
        defaultValue,
        validation,
      })
    })

    configs.push({
      zone: zone,
      fields: [],
    })
  })

  return null
}

function getFormFieldValue(
  fileIndex: number,
  formIndex: number,
  fieldKey: string,
  value: string
): string {
  const import_ = generateCustomFieldConfigName(fileIndex)
  return `${import_}.forms[${formIndex}].fields.${fieldKey}.${value}`
}

function getFormEntryConfigPath(model: CustomFieldModel, zone: string): string {
  return `${model}.${zone}.$config`
}

function getDisplays(
  path: NodePath<ExportDefaultDeclaration>,
  model: CustomFieldModel,
  index: number,
  file: string
): Display[] | null {
  const configArgument = getConfigArgument(path)

  if (!configArgument) {
    return null
  }

  const displayProperty = configArgument.properties.find(
    (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "display" })
  ) as ObjectProperty | undefined

  if (!displayProperty) {
    return null
  }

  if (!isArrayExpression(displayProperty.value)) {
    logger.warn(
      `The 'display' property in ${file} is malformed. The 'display' property must be an array of objects.`
    )
    return null
  }

  const displays: Display[] = []

  displayProperty.value.elements.forEach((element, j) => {
    if (!isObjectExpression(element)) {
      return
    }

    const zoneProperty = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "zone" })
    ) as ObjectProperty | undefined

    if (!zoneProperty) {
      logger.warn(
        `The 'zone' property is missing from the ${j} entry in the 'display' property in ${file}. The 'zone' property is required to load a custom field display.`
      )
      return
    }

    if (!isStringLiteral(zoneProperty.value)) {
      logger.warn(
        `The 'zone' property in the ${j} entry in the 'display' property in ${file} is not a string literal. The 'zone' property must be a string literal, e.g. 'general' or 'attributes'.`
      )
      return
    }

    const zone = zoneProperty.value.value
    const fullPath = getDisplayEntryPath(model, zone)

    if (
      !isValidCustomFieldDisplayZone(zone) ||
      !isValidCustomFieldDisplayPath(fullPath)
    ) {
      logger.warn(
        `The 'display' property in the ${j} entry in the 'display' property in ${file} is not a valid custom field display zone for the ${model} model. Received: ${zone}.`
      )
      return
    }

    const componentProperty = element.properties.find(
      (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "component" })
    ) as ObjectProperty | undefined

    if (!componentProperty) {
      logger.warn(
        `The 'component' property is missing from the ${j} entry in the 'display' property in ${file}. The 'component' property is required to load a custom field display.`
      )
      return
    }

    displays.push({
      zone: zone,
      Component: getDisplayComponent(index, j),
    })
  })

  return displays.length > 0 ? displays : null
}

function getDisplayEntryPath(model: CustomFieldModel, zone: string): string {
  return `${model}.${zone}.$display`
}

function getDisplayComponent(
  fileIndex: number,
  displayEntryIndex: number
): string {
  const import_ = generateCustomFieldConfigName(fileIndex)
  return `${import_}.display[${displayEntryIndex}].component`
}

function getLink(
  path: NodePath<ExportDefaultDeclaration>,
  index: number,
  file: string
): Link | null {
  const configArgument = getConfigArgument(path)

  if (!configArgument) {
    return null
  }

  const linkProperty = configArgument.properties.find(
    (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "link" })
  ) as ObjectProperty | undefined

  if (!linkProperty) {
    logger.warn(
      `The 'link' property is missing from the custom field config for ${file}. The 'link' property is required to load the custom field config.`
    )
    return null
  }

  const import_ = generateCustomFieldConfigName(index)

  return {
    field: `${import_}.link`,
  }
}

function getModel(
  path: NodePath<ExportDefaultDeclaration>,
  file: string
): CustomFieldModel | null {
  const configArgument = getConfigArgument(path)

  if (!configArgument) {
    return null
  }

  const modelProperty = configArgument.properties.find(
    (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "model" })
  ) as ObjectProperty | undefined

  if (!modelProperty) {
    return null
  }

  if (!isStringLiteral(modelProperty.value)) {
    logger.warn(
      `Invalid model found for ${file}. 'model' is required to load the custom field config. Please ensure that the 'model' property is a string literal, e.g. 'product' or 'customer'. Importing a model from a different package is not supported, and neither is using a variable or template literal.`
    )
    return null
  }

  const model = modelProperty.value.value.trim()

  if (!isValidCustomFieldModel(model)) {
    logger.warn(
      `Invalid model found for ${file}, received: ${model}. 'model' is required to load the custom field config. Please ensure that the 'model' property is set to a valid custom field model, e.g. 'product' or 'customer'.`
    )
    return null
  }

  return model
}

function getConfigArgument(
  path: NodePath<ExportDefaultDeclaration>
): ObjectExpression | null {
  if (!isCallExpression(path.node.declaration)) {
    return null
  }

  if (
    !isIdentifier(path.node.declaration.callee, {
      name: "defineCustomFieldsConfig",
    })
  ) {
    return null
  }

  const configArgument = path.node.declaration.arguments[0]

  if (!isObjectExpression(configArgument)) {
    return null
  }

  return configArgument
}

function getFormsArgument(
  path: NodePath<ExportDefaultDeclaration>,
  file: string
): ArrayExpression | null {
  const configArgument = getConfigArgument(path)

  if (!configArgument) {
    return null
  }

  const formProperty = configArgument.properties.find(
    (p) => isObjectProperty(p) && isIdentifier(p.key, { name: "forms" })
  ) as ObjectProperty | undefined

  if (!formProperty) {
    return null
  }

  if (!isArrayExpression(formProperty.value)) {
    logger.warn(
      `The 'forms' property in ${file} is malformed. The 'forms' property must be an array of objects.`
    )
    return null
  }

  return formProperty.value
}
