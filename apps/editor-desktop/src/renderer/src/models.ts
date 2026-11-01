/**
 * 本地模式未配置模型时的默认值。
 * 真源在 `shared/providers` 的 `DEFAULT_MODEL_ID`，这里只做转发，
 * 避免两处各写一份默认模型（改一处即可）。
 */
export { DEFAULT_MODEL_ID as DEFAULT_LOCAL_MODEL } from '../../shared/providers';
