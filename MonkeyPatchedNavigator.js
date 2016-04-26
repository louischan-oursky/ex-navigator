import React from 'react';
import {
  Dimensions,
  Navigator,
  NativeModules,
  PanResponder,
} from 'react-native';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SCREEN_HEIGHT = Dimensions.get('window').height;

var AnimationsDebugModule = NativeModules.AnimationsDebugModule;
var invariant = require('fbjs/lib/invariant');

function clamp(min, value, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

class MonkeyPatchedNavigator extends Navigator {
  constructor(props) {
    super(props);

    this._handlePanResponderRelease = (e, gestureState) => {
      var sceneConfig = this.state.sceneConfigStack[this.state.presentedIndex];
      var releaseGestureAction = this.state.activeGesture;
      if (!releaseGestureAction) {
        // The gesture may have been detached while responder, so there is no action here
        return;
      }
      var releaseGesture = sceneConfig.gestures[releaseGestureAction];
      var destIndex = this.state.presentedIndex + this._deltaForGestureAction(this.state.activeGesture);
      if (this.spring.getCurrentValue() === 0) {
        // The spring is at zero, so the gesture is already complete
        this.spring.setCurrentValue(0).setAtRest();
        this._completeTransition();
        return;
      }
      var isTravelVertical = releaseGesture.direction === 'top-to-bottom' || releaseGesture.direction === 'bottom-to-top';
      var isTravelInverted = releaseGesture.direction === 'right-to-left' || releaseGesture.direction === 'bottom-to-top';
      var velocity, gestureDistance;
      if (isTravelVertical) {
        velocity = isTravelInverted ? -gestureState.vy : gestureState.vy;
        gestureDistance = isTravelInverted ? -gestureState.dy : gestureState.dy;
      } else {
        velocity = isTravelInverted ? -gestureState.vx : gestureState.vx;
        gestureDistance = isTravelInverted ? -gestureState.dx : gestureState.dx;
      }
      var transitionVelocity = clamp(-10, velocity, 10);
      if (Math.abs(velocity) < releaseGesture.notMoving) {
        // The gesture velocity is so slow, is "not moving"
        var hasGesturedEnoughToComplete = gestureDistance > releaseGesture.fullDistance * releaseGesture.stillCompletionRatio;
        transitionVelocity = hasGesturedEnoughToComplete ? releaseGesture.snapVelocity : -releaseGesture.snapVelocity;
      }
      if (transitionVelocity < 0 || this._doesGestureOverswipe(releaseGestureAction)) {
        // This gesture is to an overswiped region or does not have enough velocity to complete
        // If we are currently mid-transition, then this gesture was a pending gesture. Because this gesture takes no action, we can stop here
        if (this.state.transitionFromIndex == null) {
          // There is no current transition, so we need to transition back to the presented index
          var transitionBackToPresentedIndex = this.state.presentedIndex;
          // slight hack: change the presented index for a moment in order to transitionTo correctly
          this.state.presentedIndex = destIndex;
          this._transitionTo(
            transitionBackToPresentedIndex,
            -transitionVelocity,
            1 - this.spring.getCurrentValue(),
            null,
            {
              isPanResponderRelease: true,
            }
          );
        }
      } else {
        // The gesture has enough velocity to complete, so we transition to the gesture's destination
        this._emitWillFocus(this.state.routeStack[destIndex]);
        this._transitionTo(
          destIndex,
          transitionVelocity,
          null,
          () => {
            if (releaseGestureAction === 'pop') {
              this._cleanScenesPastIndex(destIndex);
            }
          },
          {
            isPanResponderRelease: true,
          }
        );
      }
      this._detachGesture();
    };

    // patch panResponder
    this.panGesture = PanResponder.create({
      onMoveShouldSetPanResponder: this._handleMoveShouldSetPanResponder,
      onPanResponderRelease: this._handlePanResponderRelease,
      onPanResponderMove: this._handlePanResponderMove,
      onPanResponderTerminate: this._handlePanResponderTerminate,
    });

    // patch _transitionTo
    this._transitionTo = (destIndex, velocity, jumpSpringTo, cb, villageOptions) => {
      if (destIndex === this.state.presentedIndex) {
        return;
      }
      if (this.state.transitionFromIndex !== null) {
        this.state.transitionQueue.push({
          destIndex,
          velocity,
          cb,
        });
        return;
      }
      this.state.transitionFromIndex = this.state.presentedIndex;
      this.state.presentedIndex = destIndex;
      this.state.transitionCb = cb;
      this._onAnimationStart();
      if (AnimationsDebugModule) {
        AnimationsDebugModule.startRecordingFps();
      }
      var sceneConfig = this.state.sceneConfigStack[this.state.transitionFromIndex] ||
        this.state.sceneConfigStack[this.state.presentedIndex];
      invariant(
        sceneConfig,
        'Cannot configure scene at index ' + this.state.transitionFromIndex
      );
      if (jumpSpringTo != null) {
        this.spring.setCurrentValue(jumpSpringTo);
      }
      this.spring.setOvershootClampingEnabled(true);
      this.spring.getSpringConfig().friction = sceneConfig.springFriction;
      this.spring.getSpringConfig().tension = sceneConfig.springTension;
      let v = velocity || sceneConfig.defaultTransitionVelocity;
      if (villageOptions && villageOptions.isPanResponderRelease) {
        if (sceneConfig.minimumTransitionVelocity && v < sceneConfig.minimumTransitionVelocity) {
          v = sceneConfig.minimumTransitionVelocity;
        }
      }
      this.spring.setVelocity(v);
      this.spring.setEndValue(1);
    };

    // patch _matchGestureAction
    this._matchGestureAction = (eligibleGestures, gestures, gestureState) => {
      if (!gestures || !eligibleGestures || !eligibleGestures.some) {
        return null;
      }
      var matchedGesture = null;
      eligibleGestures.some((gestureName, gestureIndex) => {
        var gesture = gestures[gestureName];
        if (!gesture) {
          return;
        }
        if (gesture.overswipe == null && this._doesGestureOverswipe(gestureName)) {
          // cannot swipe past first or last scene without overswiping
          return false;
        }
        var isTravelVertical = gesture.direction === 'top-to-bottom' || gesture.direction === 'bottom-to-top';
        var isTravelInverted = gesture.direction === 'right-to-left' || gesture.direction === 'bottom-to-top';

        // FIXME: village specific changes
        var currentLoc;
        if (gestureState.x0 === 0 && gestureState.y0 === 0) {
          currentLoc = isTravelVertical ? gestureState.moveY : gestureState.moveX;
        } else {
          currentLoc = isTravelVertical ? gestureState.y0 : gestureState.x0;
        }
        // FIXME: village specific changes

        var travelDist = isTravelVertical ? gestureState.dy : gestureState.dx;
        var oppositeAxisTravelDist =
          isTravelVertical ? gestureState.dx : gestureState.dy;
        var edgeHitWidth = gesture.edgeHitWidth;
        if (isTravelInverted) {
          currentLoc = -currentLoc;
          travelDist = -travelDist;
          oppositeAxisTravelDist = -oppositeAxisTravelDist;
          edgeHitWidth = isTravelVertical ?
            -(SCREEN_HEIGHT - edgeHitWidth) :
            -(SCREEN_WIDTH - edgeHitWidth);
        }
        var moveStartedInRegion = gesture.edgeHitWidth == null ||
          currentLoc < edgeHitWidth;
        if (!moveStartedInRegion) {
          return false;
        }
        var moveTravelledFarEnough = travelDist >= gesture.gestureDetectMovement;
        if (!moveTravelledFarEnough) {
          return false;
        }
        var directionIsCorrect = Math.abs(travelDist) > Math.abs(oppositeAxisTravelDist) * gesture.directionRatio;
        if (directionIsCorrect) {
          matchedGesture = gestureName;
          return true;
        } else {
          this._eligibleGestures = this._eligibleGestures.slice().splice(gestureIndex, 1);
        }
      });
      return matchedGesture || null;
    };
  }
}

module.exports = MonkeyPatchedNavigator;
