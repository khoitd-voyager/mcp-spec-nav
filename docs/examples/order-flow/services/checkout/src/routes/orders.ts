import { Router } from "express";
import { createOrderHandler } from "../handlers/createOrder";

const router = Router();
router.post("/", createOrderHandler);
export default router;
