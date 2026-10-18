/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include <Arduino.h>
#include <M5StackChan.h>

void setup()
{
    /* Init StackChan */
    M5StackChan.begin();

    /* Setup display */
    M5StackChan.Display().setTextSize(2);
    M5StackChan.Display().setTextScroll(true);
    M5StackChan.Display().setTextColor(TFT_YELLOW);
    M5StackChan.Display().printf("> Touch the top to start\n");
    M5StackChan.Display().setTextColor(TFT_GREENYELLOW);

    // Set to false if high-frequency updates are needed
    // M5StackChan.Motion.setAutoAngleSyncEnabled(false);
}

void loop()
{
    M5StackChan.update();
    if (M5StackChan.TouchSensor.wasPressed()) {
        delay(200);

        /* Angle unit: 10 = 1 degrees, Speed range: 0~1000 */
        /* Range X: -1280 ~ 1280 (-128° ~ 128°), Range Y: 0 ~ 900 (0° ~ 90°) */

        /* Move to home position (0, 0) */
        M5StackChan.Motion.goHome();
        M5StackChan.Display().printf("> Go home\n");
        delay(2000);

        /* Move X servo to 100° */
        M5StackChan.Motion.moveX(1000, 200);
        M5StackChan.Display().printf("> Turn Left (Slow: 200)\n");
        delay(2000);

        /* Move X servo to -100° */
        M5StackChan.Motion.moveX(-1000, 200);
        M5StackChan.Display().printf("> Turn Right (Slow: 200)\n");
        delay(2000);

        /* Move X servo to 100° */
        M5StackChan.Motion.moveX(1000, 800);
        M5StackChan.Display().printf("> Turn Left (Fast: 800)\n");
        delay(2000);

        /* Move X servo to -100° */
        M5StackChan.Motion.moveX(-1000, 800);
        M5StackChan.Display().printf("> Turn Right (Fast: 800)\n");
        delay(2000);

        M5StackChan.Motion.goHome();
        M5StackChan.Display().printf("> Go home\n");
        delay(2000);

        /* Move Y servo to 90° */
        M5StackChan.Motion.moveY(900, 200);
        M5StackChan.Display().printf("> Look Up (Slow: 200)\n");
        delay(2000);

        /* Move Y servo to 0° */
        M5StackChan.Motion.moveY(0, 200);
        M5StackChan.Display().printf("> Look Down (Slow: 200)\n");
        delay(2000);

        /* Move Y servo to 90° */
        M5StackChan.Motion.moveY(900, 800);
        M5StackChan.Display().printf("> Look Up (Fast: 800)\n");
        delay(2000);

        /* Move Y servo to 0° */
        M5StackChan.Motion.moveY(0, 800);
        M5StackChan.Display().printf("> Look Down (Fast: 800)\n");
        delay(2000);

        /* Move X servo to 60°, Y servo to 70° */
        M5StackChan.Motion.move(600, 700);
        M5StackChan.Display().printf("> Top Left\n");
        delay(2000);

        M5StackChan.Motion.goHome();
        M5StackChan.Display().printf("> Go home\n");
        delay(2000);

        /* Move X servo to -60°, Y servo to 70° */
        M5StackChan.Motion.move(-600, 700);
        M5StackChan.Display().printf("> Top Right\n");
        delay(2000);

        M5StackChan.Motion.goHome();
        M5StackChan.Display().printf("> Go home\n");
        delay(2000);

        /* Only X axis supports continuous 360° rotation. Y axis does not. */
        /* Velocity range: -1000 ~ 1000 (Negative: CW, Positive: CCW) */

        /* Rotate clockwise */
        M5StackChan.Motion.rotateX(-300);
        M5StackChan.Display().printf("> Rotate clockwise (Slow: 300)\n");
        delay(3000);

        /* Rotate clockwise */
        M5StackChan.Motion.rotateX(-800);
        M5StackChan.Display().printf("> Rotate clockwise (Fast: 800)\n");
        delay(3000);

        M5StackChan.Motion.goHome();
        M5StackChan.Display().printf("> Go home\n");
        delay(2000);

        /* Rotate counter-clockwise */
        M5StackChan.Motion.rotateX(300);
        M5StackChan.Display().printf("> Rotate counter-clockwise (Slow: 300)\n");
        delay(3000);

        /* Rotate counter-clockwise */
        M5StackChan.Motion.rotateX(800);
        M5StackChan.Display().printf("> Rotate counter-clockwise (Fast: 800)\n");
        delay(3000);

        M5StackChan.Motion.goHome();
        M5StackChan.Display().printf("> Go home\n");
        delay(2000);

        M5StackChan.Display().setTextColor(TFT_YELLOW);
        M5StackChan.Display().printf("> Touch the top to start\n");
        M5StackChan.Display().setTextColor(TFT_GREENYELLOW);
    }

    delay(100);
}
