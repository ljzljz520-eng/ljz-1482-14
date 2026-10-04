import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodSchema } from "zod";
import { AppError, ErrorCodes } from "./errors.js";

/** zod 请求体校验：非法载荷以结构化错误返回，前端可定位字段。 */
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new AppError(ErrorCodes.VALIDATION, "请求参数校验失败", 422, {
          fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
        }));
        return;
      }
      next(err);
    }
  };
}

export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next);
  };
}
