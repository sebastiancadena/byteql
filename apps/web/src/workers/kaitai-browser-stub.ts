const unsupported = (): never => {
  throw new Error('This optional Kaitai runtime operation is unavailable in the browser.');
};

export const decode = unsupported;
export const inflate = unsupported;
export const inflateSync = unsupported;

export default { decode, inflate, inflateSync };
